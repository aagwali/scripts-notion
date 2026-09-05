#!/usr/bin/env -S npx tsx
/**
 * Archivage des Phases terminees vers la base Notion "Phases archivees".
 *
 * Objectif : sortir les phases terminales de la base "Phases" pour qu'elles
 * cessent d'encombrer le selecteur de la relation "Phase" sur Tasks et Docs,
 * sans jamais perdre le lien vers les Tasks/Docs qui y etaient rattachees.
 *
 * Une relation Notion est liee a une seule data source : on ne peut pas faire
 * pointer Tasks.Phase vers une page d'une autre base. Le lien est donc reporte
 * sur une seconde relation, "Phase archivee", pointant vers la base archive.
 *
 * Ordre strict, par phase :
 *   creer l'archive  ->  reattribuer Tasks/Docs  ->  verifier  ->  corbeille
 * Une seule verification en echec suffit a conserver la phase d'origine.
 *
 * Idempotence : la page archive porte l'id de la phase d'origine dans
 * "Phase source ID". Un run interrompu est repris sans rien recreer.
 *
 * Usage :
 *   npx tsx archive-phases.ts [--dry-run]
 *
 * Variables d'environnement (.env) : NOTION_TOKEN
 *
 * Node >= 18 requis (fetch natif).
 */

import "dotenv/config";

// --- Config -----------------------------------------------------------

const PHASES_DATABASE_ID = "34a8b4b8-8465-80e7-989e-ed7c68b525fa"; // Phases
const TASKS_DATABASE_ID = "3438b4b8-8465-80a6-ac08-d30445212e90"; // Tasks
const DOCS_DATABASE_ID = "3448b4b8-8465-8016-876c-df35377f3d83"; // Docs

const ARCHIVE_DATABASE_ID = "3d28b4b8-8465-819d-808a-f6bdb4978194"; // Phases archivees

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2022-06-28";

/** Statuts terminaux declenchant l'archivage. */
const TERMINAL_STATUSES = ["Done", "Cancelled"];

/** Relation Tasks/Docs -> Phases, vidée par la reattribution. */
const PHASE_PROP = "Phase";
/** Relation Tasks/Docs -> Phases archivees, portant le lien apres archivage. */
const ARCHIVED_PHASE_PROP = "Phase archivée";
/** Cle d'idempotence : id de la page Phases d'origine, sur la page archive. */
const SOURCE_ID_PROP = "Phase source ID";
const ARCHIVED_AT_PROP = "Archived at";

const DRY_RUN = process.argv.includes("--dry-run");

const RICH_TEXT_CHUNK = 2000; // limite Notion par objet rich_text
const THROTTLE_MS = 350; // limite Notion ~3 req/s
const MAX_RETRIES = 4;

// --- Notion ---------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ce script ecrit beaucoup plus que les deux scripts d'ingestion : throttle
 * systematique et retry sur 429 / 5xx, sinon un lot de phases un peu gros
 * part en echec au milieu d'une reattribution.
 */
async function notion<T>(path: string, init: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await sleep(THROTTLE_MS);

    const resp = await fetch(`https://api.notion.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (resp.ok) return (await resp.json()) as T;

    const retriable = resp.status === 429 || resp.status >= 500;
    if (!retriable || attempt >= MAX_RETRIES) {
      throw new Error(`Notion API ${resp.status} sur ${path} : ${await resp.text()}`);
    }

    const retryAfter = Number(resp.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
  }
}

interface NotionPage {
  id: string;
  properties: Record<string, any>;
}

interface QueryResponse {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

async function queryAll(databaseId: string, filter: unknown): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;

  do {
    const data = await notion<QueryResponse>(`/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({
        filter,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });

    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
  } while (cursor);

  return pages;
}

// --- Lecture de proprietes -------------------------------------------------

function titleOf(page: NotionPage, prop = "Name"): string {
  return (page.properties[prop]?.title ?? [])
    .map((t: { plain_text: string }) => t.plain_text)
    .join("");
}

function plainTextOf(page: NotionPage, prop: string): string {
  return (page.properties[prop]?.rich_text ?? [])
    .map((t: { plain_text: string }) => t.plain_text)
    .join("");
}

/**
 * Notion plafonne les relations a 25 elements par reponse. Sans importance
 * ici : on ne lit que des relations limitees a 1 (Project, Sponsor, Phase).
 * Les Tasks/Docs d'une phase sont recuperes par requete inverse, pas via
 * Phases.Tasks / Phases.Docs, justement pour ne pas buter sur ce plafond.
 */
function relationIds(page: NotionPage, prop: string): string[] {
  return (page.properties[prop]?.relation ?? []).map((r: { id: string }) => r.id);
}

function dateOf(page: NotionPage, prop: string): unknown {
  return page.properties[prop]?.date ?? null;
}

function selectNameOf(page: NotionPage, prop: string): string | null {
  return page.properties[prop]?.select?.name ?? null;
}

function chunkRichText(text: string): Array<{ text: { content: string } }> {
  if (!text) return [];

  const chunks: Array<{ text: { content: string } }> = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_CHUNK) {
    chunks.push({ text: { content: text.slice(i, i + RICH_TEXT_CHUNK) } });
  }
  return chunks;
}

// --- Archivage -------------------------------------------------------------

/** Page archive deja creee pour cette phase, si un run precedent s'est arrete. */
async function findArchive(phaseId: string): Promise<string | null> {
  const rows = await queryAll(ARCHIVE_DATABASE_ID, {
    property: SOURCE_ID_PROP,
    rich_text: { equals: phaseId },
  });
  return rows[0]?.id ?? null;
}

async function createArchive(phase: NotionPage): Promise<string> {
  const status = selectNameOf(phase, "Status");
  const priority = selectNameOf(phase, "Priority");

  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: titleOf(phase).slice(0, 2000) || "(sans nom)" } }] },
    Project: { relation: relationIds(phase, "Project").map((id) => ({ id })) },
    Sponsor: { relation: relationIds(phase, "Sponsor").map((id) => ({ id })) },
    "Start date": { date: dateOf(phase, "Start date") },
    "Target end date": { date: dateOf(phase, "Target end date") },
    Deliverable: { rich_text: chunkRichText(plainTextOf(phase, "Deliverable")) },
    ...(status ? { Status: { select: { name: status } } } : {}),
    ...(priority ? { Priority: { select: { name: priority } } } : {}),
    [SOURCE_ID_PROP]: { rich_text: [{ text: { content: phase.id } }] },
    [ARCHIVED_AT_PROP]: { date: { start: new Date().toISOString() } },
  };

  const created = await notion<{ id: string }>("/pages", {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: ARCHIVE_DATABASE_ID }, properties }),
  });
  return created.id;
}

/** Bascule le lien : "Phase archivee" pointe l'archive, "Phase" est vidée. */
async function reassign(pageId: string, archiveId: string): Promise<void> {
  await notion(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        [ARCHIVED_PHASE_PROP]: { relation: [{ id: archiveId }] },
        [PHASE_PROP]: { relation: [] },
      },
    }),
  });
}

/** Relit la page : sans cette confirmation, rien n'est mis a la corbeille. */
async function isReassigned(pageId: string, archiveId: string): Promise<boolean> {
  const page = await notion<NotionPage>(`/pages/${pageId}`, { method: "GET" });
  return (
    relationIds(page, ARCHIVED_PHASE_PROP).includes(archiveId) &&
    relationIds(page, PHASE_PROP).length === 0
  );
}

interface Target {
  kind: "task" | "doc";
  page: NotionPage;
}

interface PhaseOutcome {
  status: "archived" | "partial" | "skipped";
  reassigned: number;
}

async function processPhase(phase: NotionPage): Promise<PhaseOutcome> {
  const name = titleOf(phase) || "(sans nom)";
  console.log(`- phase ${phase.id} "${name}" [${selectNameOf(phase, "Status")}]`);

  const existing = await findArchive(phase.id);

  const targets: Target[] = [
    ...(await queryAll(TASKS_DATABASE_ID, {
      property: PHASE_PROP,
      relation: { contains: phase.id },
    })).map((page): Target => ({ kind: "task", page })),
    ...(await queryAll(DOCS_DATABASE_ID, {
      property: PHASE_PROP,
      relation: { contains: phase.id },
    })).map((page): Target => ({ kind: "doc", page })),
  ];

  const taskCount = targets.filter((t) => t.kind === "task").length;
  console.log(`  ${taskCount} task(s), ${targets.length - taskCount} doc(s) a reattribuer`);

  if (DRY_RUN) {
    console.log(`  [dry-run] archive ${existing ? `existante ${existing}` : "a creer"}`);
    for (const { kind, page } of targets) {
      console.log(`  [dry-run] ${kind} ${page.id} "${titleOf(page)}" serait reattribue(e)`);
    }
    console.log(`  [dry-run] phase ${phase.id} serait mise a la corbeille`);
    return { status: "skipped", reassigned: 0 };
  }

  const archiveId = existing ?? (await createArchive(phase));
  console.log(`  archive ${archiveId} (${existing ? "existante, reprise" : "creee"})`);

  let reassigned = 0;
  const failures: string[] = [];

  for (const { kind, page } of targets) {
    try {
      await reassign(page.id, archiveId);
      if (!await isReassigned(page.id, archiveId)) {
        throw new Error("relecture : lien non confirme");
      }
      console.log(`  ok ${kind} ${page.id} "${titleOf(page)}" -> archive ${archiveId}`);
      reassigned++;
    } catch (err) {
      console.log(`  ECHEC ${kind} ${page.id} "${titleOf(page)}" : ${(err as Error).message}`);
      failures.push(`${kind} ${page.id}`);
    }
  }

  if (failures.length > 0) {
    console.log(
      `  INCOMPLET : phase ${phase.id} conservee — ${reassigned}/${targets.length} reattribue(s), ` +
      `en echec : ${failures.join(", ")}`,
    );
    console.log(`  rollback : repointer ces pages sur "${PHASE_PROP}" = ${phase.id}`);
    return { status: "partial", reassigned };
  }

  await notion(`/pages/${phase.id}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
  console.log(`  phase ${phase.id} mise a la corbeille (${reassigned} reattribution(s) confirmee(s))`);

  return { status: "archived", reassigned };
}

// --- Main -----------------------------------------------------------------

async function main(): Promise<void> {
  if (!NOTION_TOKEN) {
    console.error("NOTION_TOKEN manquant (export NOTION_TOKEN=secret_xxx)");
    process.exit(1);
  }

  if (!ARCHIVE_DATABASE_ID) {
    console.error(
      "ARCHIVE_DATABASE_ID vide : creer la base \"Phases archivees\", la partager avec " +
      "l'integration, puis renseigner son id en tete de ce fichier.",
    );
    process.exit(1);
  }

  if (DRY_RUN) console.log("Mode --dry-run : aucune ecriture.\n");

  const phases = await queryAll(PHASES_DATABASE_ID, {
    or: TERMINAL_STATUSES.map((name) => ({ property: "Status", select: { equals: name } })),
  });

  if (phases.length === 0) {
    console.log("Aucune phase terminale a archiver.");
    return;
  }

  console.log(`${phases.length} phase(s) au statut ${TERMINAL_STATUSES.join(" / ")}.\n`);

  let archived = 0;
  let partial = 0;
  let failed = 0;
  let reassignedTotal = 0;

  for (const phase of phases) {
    try {
      const outcome = await processPhase(phase);
      reassignedTotal += outcome.reassigned;
      if (outcome.status === "archived") archived++;
      if (outcome.status === "partial") partial++;
    } catch (err) {
      // Erreur hors boucle de reattribution (creation d'archive, requete...) :
      // la phase n'a pas ete touchee, elle sera reprise au prochain run.
      console.log(`  ECHEC phase ${phase.id} : ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(
    `\nTermine. ${archived} archivee(s), ${partial} incomplete(s), ${failed} echec(s), ` +
    `${reassignedTotal} reattribution(s) confirmee(s).`,
  );

  if (partial > 0 || failed > 0) process.exit(1);
}

main();
