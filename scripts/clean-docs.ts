#!/usr/bin/env -S npx tsx
/**
 * Nettoyage de la base Notion "Docs" : mise a la corbeille des journaux de run
 * et des input briefs relus, puis envoi d'un recapitulatif par email.
 *
 * Perimetre : Type = "Log" ou "Input brief", Status = "Reviewed", plus vieux
 * que 7 jours. Ces deux types sont produits chaque jour par une tache aval ;
 * une fois relus ils n'ont plus de lecteur, et leur accumulation noie les
 * vrais documents de la base dans les vues et les selecteurs. Les autres types
 * (Tech spec, Reference, Procedure...) ne sont jamais touches, quel que soit
 * leur age.
 *
 * La suppression est une mise a la corbeille Notion, pas un effacement :
 * Notion conserve 30 jours, ce qui est la vraie fenetre de rollback. Le
 * recapitulatif liste les liens vers les pages en corbeille, et fait office de trace
 * durable — les logs GitHub Actions, eux, expirent a 90 jours.
 *
 * Le recapitulatif part a chaque run, meme vide : recevoir "0 doc" chaque dimanche
 * dit que le job a tourne, ce qu'un silence ne dit pas.
 *
 * Usage :
 *   npx tsx scripts/clean-docs.ts [--dry-run]
 *
 * Variables d'environnement (.env) :
 *   NOTION_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *
 * Node >= 18 requis (fetch natif, Buffer base64url).
 */

import "dotenv/config";
import { instance } from "../config/index.ts";

// --- Config -----------------------------------------------------------

const DOCS_DATABASE_ID = instance.notion.databases.docs.database_id;

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2022-06-28";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const TYPE_PROP = "Type";
const STATUS_PROP = "Status";

/** Seuls ces docs sont nettoyes. Tout autre Type ou Status est hors perimetre. */
const CLEANED_TYPES = ["Log", "Input brief"];
const CLEANED_STATUS = "Reviewed";

/** Age minimum, en jours, pour qu'un doc soit retenu. Strictement superieur. */
const RETENTION_DAYS = 7;

/** Fuseau qui definit "aujourd'hui", independamment de celui du runner. */
const TIMEZONE = "Europe/Paris";

const DRY_RUN = process.argv.includes("--dry-run");

const THROTTLE_MS = 350; // limite Notion ~3 req/s
const MAX_RETRIES = 4;

// --- Notion ---------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  created_time: string;
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

function titleOf(page: NotionPage, prop = "Name"): string {
  return (page.properties[prop]?.title ?? [])
    .map((t: { plain_text: string }) => t.plain_text)
    .join("");
}

/** Lien vers la page, valable aussi une fois celle-ci en corbeille. */
function notionUrl(pageId: string): string {
  return `https://app.notion.com/p/${pageId.replace(/-/g, "")}`;
}

// --- Dates ----------------------------------------------------------------

function dayIn(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Ancre a midi UTC : l'arithmetique en jours reste juste aux changements
 * d'heure, ou minuit local peut ne pas exister ou exister deux fois.
 */
function parseDay(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000);
}

/**
 * L'age se lit sur created_time, pas sur la propriete "Date".
 *
 * "Date" est absente sur la moitie de ces pages — la plupart des "Input
 * brief" n'en portent pas — et se saisit a la main, donc une faute de frappe
 * peut avancer une suppression. created_time est toujours present, pose par
 * Notion, non modifiable. Sur les pages qui ont les deux, les valeurs
 * coincident : la propriete n'apportait rien.
 *
 * Le seul ecart possible est une page creee apres coup pour un jour passe ;
 * elle est alors gardee plus longtemps, jamais supprimee plus tot.
 */
function creationDay(page: NotionPage): string {
  return dayIn(new Date(page.created_time));
}

// --- Gmail ----------------------------------------------------------------

let accessToken: string | null = null;

async function getAccessToken(): Promise<string> {
  if (accessToken) return accessToken;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID!,
      client_secret: GOOGLE_CLIENT_SECRET!,
      refresh_token: GOOGLE_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }).toString(),
  });

  const data = (await resp.json()) as { access_token?: string; error_description?: string };
  if (!resp.ok || !data.access_token) {
    throw new Error(
      `Rafraichissement du token refuse (${resp.status}) : ${data.error_description ?? "?"}. ` +
      `Si l'ecran de consentement est reste en "Testing", le refresh token expire au bout de 7 jours.`,
    );
  }

  accessToken = data.access_token;
  return accessToken;
}

async function gmail<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const resp = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!resp.ok) {
    throw new Error(`Gmail API ${resp.status} sur ${path} : ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

/**
 * Le recapitulatif part du compte authentifie vers lui-meme : aucune adresse a
 * configurer, et rien de personnel n'entre dans le depot.
 */
async function ownAddress(): Promise<string> {
  const profile = await gmail<{ emailAddress: string }>("/profile");
  return profile.emailAddress;
}

/**
 * Sujet volontairement en ASCII : cela evite l'encodage RFC 2047 des en-tetes.
 * Le corps, lui, porte des titres accentues — d'ou le base64 en UTF-8.
 */
async function sendRecap(subject: string, body: string): Promise<void> {
  const to = await ownAddress();

  const mime = [
    `To: ${to}`,
    `From: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
  ].join("\r\n");

  await gmail("/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64url") }),
  });

  console.log(`Recapitulatif envoye a ${to}.`);
}

// --- Nettoyage ------------------------------------------------------------

interface Candidate {
  page: NotionPage;
  name: string;
  type: string;
  /** Jour de creation de la page, dans TIMEZONE. */
  day: string;
  age: number;
}

interface Result extends Candidate {
  trashed: boolean;
  error?: string;
}

function formatRecap(results: Result[], today: string): { subject: string; body: string } {
  const trashed = results.filter((r) => r.trashed);
  const failed = results.filter((r) => !r.trashed);

  const subject =
    failed.length > 0
      ? `[Docs cleaning] ${trashed.length} doc(s) en corbeille, ${failed.length} echec(s)`
      : `[Docs cleaning] ${trashed.length} doc(s) en corbeille`;

  const lines = [
    `Nettoyage de la base Notion "Docs" du ${today}.`,
    "",
    `Perimetre : Type = ${CLEANED_TYPES.join(" ou ")}, Status = ${CLEANED_STATUS}, ` +
    `plus de ${RETENTION_DAYS} jours.`,
    "",
  ];

  if (trashed.length === 0 && failed.length === 0) {
    lines.push("Aucun doc a nettoyer cette semaine.");
  }

  if (trashed.length > 0) {
    lines.push(`${trashed.length} doc(s) mis a la corbeille :`, "");
    for (const r of trashed) {
      lines.push(
        `- [${r.type}] ${r.name}`,
        `  cree le ${r.day} (${r.age} j)`,
        `  ${notionUrl(r.page.id)}`,
        "",
      );
    }
    lines.push(
      "Restauration possible pendant 30 jours depuis la corbeille Notion,",
      "au-dela la suppression est definitive.",
      "",
    );
  }

  if (failed.length > 0) {
    lines.push(`${failed.length} doc(s) en echec, toujours en place :`, "");
    for (const r of failed) {
      lines.push(`- ${r.name}`, `  ${notionUrl(r.page.id)}`, `  ${r.error}`, "");
    }
  }

  return { subject, body: lines.join("\n") };
}

// --- Main -----------------------------------------------------------------

async function main(): Promise<void> {
  const missing = [
    ["NOTION_TOKEN", NOTION_TOKEN],
    ["GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID],
    ["GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET],
    ["GOOGLE_REFRESH_TOKEN", GOOGLE_REFRESH_TOKEN],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    console.error(`Variables d'environnement manquantes : ${missing.join(", ")}`);
    process.exit(1);
  }

  if (DRY_RUN) console.log("Mode --dry-run : aucune ecriture, aucun email.\n");

  const today = dayIn(new Date());
  console.log(`Jour de reference (${TIMEZONE}) : ${today}`);

  /**
   * Le filtre Notion ne porte que sur Type et Status : l'age est arbitre ici,
   * parce qu'il peut reposer sur "Date" ou sur created_time selon le doc. Le
   * lot est de l'ordre de la dizaine de pages, la lecture large ne coute rien.
   */
  const docs = await queryAll(DOCS_DATABASE_ID, {
    and: [
      { or: CLEANED_TYPES.map((name) => ({ property: TYPE_PROP, select: { equals: name } })) },
      { property: STATUS_PROP, select: { equals: CLEANED_STATUS } },
    ],
  });

  const candidates: Candidate[] = [];

  for (const page of docs) {
    const day = creationDay(page);
    const age = daysBetween(day, today);
    const name = titleOf(page) || "(sans nom)";
    const type = page.properties[TYPE_PROP]?.select?.name ?? "(sans type)";

    if (age > RETENTION_DAYS) {
      candidates.push({ page, name, type, day, age });
    } else {
      console.log(`  garde ${day} (${age} j) [${type}] "${name}"`);
    }
  }

  console.log(
    `\n${docs.length} doc(s) ${CLEANED_TYPES.join(" / ")} au statut ${CLEANED_STATUS}, ` +
    `${candidates.length} au-dela de ${RETENTION_DAYS} jours.\n`,
  );

  const results: Result[] = [];

  for (const candidate of candidates) {
    const { page, name, type, day, age } = candidate;

    if (DRY_RUN) {
      console.log(`  [dry-run] ${day} (${age} j) [${type}] "${name}" ${page.id} -> corbeille`);
      // Compte comme un succes pour que l'apercu du recapitulatif, plus bas, montre
      // exactement ce qui serait envoye.
      results.push({ ...candidate, trashed: true });
      continue;
    }

    try {
      await notion(`/pages/${page.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });
      console.log(`  corbeille ${day} (${age} j) [${type}] "${name}" ${page.id}`);
      results.push({ ...candidate, trashed: true });
    } catch (err) {
      const error = (err as Error).message;
      console.log(`  ECHEC ${day} "${name}" ${page.id} : ${error}`);
      results.push({ ...candidate, trashed: false, error });
    }
  }

  const { subject, body } = formatRecap(results, today);

  if (DRY_RUN) {
    console.log(`\n[dry-run] recapitulatif non envoye :\n\n${subject}\n\n${body}`);
    return;
  }

  const failed = results.filter((r) => !r.trashed).length;

  try {
    await sendRecap(subject, body);
  } catch (err) {
    // Le nettoyage est deja fait : plutot que de perdre la trace, on la deverse
    // dans le log du run, seul endroit ou elle subsiste jusqu'au correctif.
    console.error(`\nEnvoi du recapitulatif en echec : ${(err as Error).message}`);
    console.error(`\n--- recapitulatif non envoye ---\n${subject}\n\n${body}\n---`);
    process.exit(1);
  }

  console.log(
    `\nTermine. ${results.length - failed} doc(s) en corbeille, ${failed} echec(s).`,
  );

  if (failed > 0) process.exit(1);
}

main();
