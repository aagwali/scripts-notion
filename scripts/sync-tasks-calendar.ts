#!/usr/bin/env -S npx tsx
/**
 * Projection des dates de la base Notion "Tasks" vers Google Calendar.
 *
 * Notion reste la source de verite. Chaque tache porte deux dates
 * independantes, Deadline et Reminder, projetees chacune dans son propre
 * calendrier Google sous forme d'evenement "journee entiere". Le lien entre
 * les deux mondes est l'id de l'evenement, stocke dans la propriete Notion
 * associee -- c'est la seule cle, il n'y a pas de recherche par titre.
 *
 * Pour chaque tache et chaque couple (date, id d'evenement) :
 *
 *   date, pas d'id   creation de l'evenement, puis ecriture de son id
 *   date + id        mise a jour de l'evenement (titre, jour)
 *   pas de date, id  suppression de l'evenement et de l'id
 *   ni l'un ni l'autre  rien
 *
 * Perimetre d'un run : les taches modifiees dans les LAST_EDITED_WINDOW_HOURS
 * dernieres heures. La fenetre depasse largement l'intervalle entre deux runs
 * quotidiens, de sorte qu'un run manque soit rattrape par le suivant.
 *
 * A cette fenetre s'ajoute un filtre sur le contenu, et c'est la que se joue
 * le troisieme cas. Filtrer sur "Deadline >= aujourd'hui OU Reminder >=
 * aujourd'hui" exclurait mecaniquement la tache dont on vient d'effacer la
 * date : plus de date, donc plus de ligne remontee, donc un evenement
 * orpheline dans l'agenda pour toujours. Le filtre retient donc aussi toute
 * tache portant un id d'evenement, quelle que soit sa date. Une deadline
 * passee mais encore liee est ainsi rafraichie plutot qu'abandonnee.
 *
 * Ecrire l'id dans Notion modifie la page, qui repasse donc dans la fenetre
 * au run suivant : les mises a jour sont ecrites telles quelles a chaque
 * fois, sans comparaison prealable avec l'etat de l'evenement. C'est
 * volontaire -- un PATCH Google est idempotent, et une lecture prealable
 * couterait un appel de plus pour economiser un appel.
 *
 * Le jour de reference est calcule dans TIMEZONE, pas dans le fuseau du
 * runner : un runner GitHub est en UTC et se trompe d'un jour a minuit.
 *
 * Usage :
 *   npx tsx scripts/sync-tasks-calendar.ts [--dry-run]
 *
 * Variables d'environnement (.env) :
 *   NOTION_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *
 * Le refresh token doit couvrir le scope Calendar : il est genere par
 * scripts/google-auth.ts, qui demande Gmail et Calendar en une fois.
 *
 * Node >= 18 requis (fetch natif).
 */

import "dotenv/config";

// --- Config -----------------------------------------------------------

const TASKS_DATABASE_ID = "3438b4b8-8465-80a6-ac08-d30445212e90"; // Tasks

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2022-06-28";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Fuseau qui definit "aujourd'hui", independamment de celui du runner. */
const TIMEZONE = "Europe/Paris";

/**
 * Ce que le run considere comme "recemment modifie". Genereux devant les 24h
 * qui separent deux runs : un run manque est rattrape par le suivant.
 */
const LAST_EDITED_WINDOW_HOURS = 30;

const DRY_RUN = process.argv.includes("--dry-run");

const THROTTLE_MS = 350; // limite Notion ~3 req/s
const MAX_RETRIES = 4;

/**
 * Les deux dates projetees. Chacune a son calendrier dedie (alimente
 * jusqu'ici par Make) et sa propriete texte portant l'id de l'evenement.
 * Les noms de proprietes sont des cles d'API : ils doivent correspondre au
 * caractere pres a ceux de la base Tasks.
 */
interface Slot {
  label: string;
  dateProp: string;
  eventIdProp: string;
  calendarId: string;
}

const SLOTS: Slot[] = [
  {
    label: "Deadline",
    dateProp: "Deadline",
    eventIdProp: "Google Event Id (deadline)",
    calendarId:
      "46e7917d35bd73470e53670206150853ef5d6d7e4c95f86883861f4eeef7eccf@group.calendar.google.com",
  },
  {
    label: "Reminder",
    dateProp: "Reminder",
    eventIdProp: "Google Event Id (reminder)",
    calendarId:
      "885a7de408da9ea3756b77cc2bf356eccb6170d0e0a78a003202949a4f9ddb3a@group.calendar.google.com",
  },
];

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
  url?: string;
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

/**
 * Seule la partie calendaire compte : l'evenement produit est une journee
 * entiere. Notion renvoie un datetime si l'heure a ete saisie, on tronque.
 */
function dayOf(page: NotionPage, prop: string): string | null {
  const start = page.properties[prop]?.date?.start;
  return typeof start === "string" ? start.slice(0, 10) : null;
}

function textOf(page: NotionPage, prop: string): string | null {
  const value = (page.properties[prop]?.rich_text ?? [])
    .map((t: { plain_text: string }) => t.plain_text)
    .join("")
    .trim();
  return value === "" ? null : value;
}

/** Ecrit (ou vide, si `value` est null) une propriete texte. */
async function writeText(pageId: string, prop: string, value: string | null): Promise<void> {
  await notion(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        [prop]: { rich_text: value === null ? [] : [{ text: { content: value } }] },
      },
    }),
  });
}

// --- Google Calendar --------------------------------------------------------

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

/** Erreur portant le statut HTTP, pour distinguer l'evenement disparu du reste. */
class CalendarError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function calendar<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const token = await getAccessToken();
  const resp = await fetch(`${CALENDAR_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!resp.ok) {
    throw new CalendarError(resp.status, `Calendar API ${resp.status} sur ${path} : ${await resp.text()}`);
  }
  // DELETE repond 204 sans corps.
  return resp.status === 204 ? null : ((await resp.json()) as T);
}

/**
 * Un evenement Google "journee entiere" se decrit par des dates nues, avec
 * une fin EXCLUSIVE : une journee unique va de J a J+1.
 */
function eventBody(summary: string, day: string, taskUrl?: string) {
  return {
    summary,
    start: { date: day },
    end: { date: addDays(day, 1) },
    ...(taskUrl ? { source: { title: "Notion", url: taskUrl } } : {}),
  };
}

async function createEvent(slot: Slot, summary: string, day: string, url?: string): Promise<string> {
  const created = await calendar<{ id: string }>(
    `/calendars/${encodeURIComponent(slot.calendarId)}/events`,
    { method: "POST", body: JSON.stringify(eventBody(summary, day, url)) },
  );
  return created!.id;
}

async function patchEvent(
  slot: Slot,
  eventId: string,
  summary: string,
  day: string,
  url?: string,
): Promise<void> {
  await calendar(
    `/calendars/${encodeURIComponent(slot.calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "PATCH", body: JSON.stringify(eventBody(summary, day, url)) },
  );
}

async function deleteEvent(slot: Slot, eventId: string): Promise<void> {
  await calendar(
    `/calendars/${encodeURIComponent(slot.calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
}

/** L'evenement n'existe plus cote Google : supprime a la main, ou deja efface. */
function isGone(err: unknown): boolean {
  return err instanceof CalendarError && (err.status === 404 || err.status === 410);
}

// --- Calendrier ------------------------------------------------------------

/** Jour courant (YYYY-MM-DD) dans TIMEZONE. en-CA formate en ISO. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Ancre a midi UTC : l'arithmetique en jours reste juste aux changements
 * d'heure, ou minuit local peut ne pas exister ou exister deux fois.
 */
function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

// --- Traitement d'un slot ---------------------------------------------------

type Action = "created" | "updated" | "deleted" | "recreated" | "untouched";

/**
 * Applique a un slot l'ecart entre la date Notion et l'evenement pointe.
 * Retourne l'action effectuee, pour le decompte final.
 */
async function syncSlot(page: NotionPage, slot: Slot, name: string): Promise<Action> {
  const day = dayOf(page, slot.dateProp);
  const eventId = textOf(page, slot.eventIdProp);
  const summary = `[${slot.label}] ${name}`;
  const url = page.url;

  if (day === null && eventId === null) return "untouched";

  if (day === null) {
    // Date effacee dans Notion : l'evenement n'a plus de raison d'etre.
    if (DRY_RUN) {
      console.log(`  [dry-run] ${slot.label} : suppression de l'evenement ${eventId}`);
      return "deleted";
    }
    try {
      await deleteEvent(slot, eventId!);
    } catch (err) {
      // Deja disparu cote Google : il reste a nettoyer l'id cote Notion.
      if (!isGone(err)) throw err;
    }
    await writeText(page.id, slot.eventIdProp, null);
    console.log(`  ${slot.label} : evenement supprime (${eventId})`);
    return "deleted";
  }

  if (eventId === null) {
    if (DRY_RUN) {
      console.log(`  [dry-run] ${slot.label} : creation le ${day} ("${summary}")`);
      return "created";
    }
    const created = await createEvent(slot, summary, day, url);
    try {
      await writeText(page.id, slot.eventIdProp, created);
    } catch (err) {
      // L'evenement existe mais Notion ne le connait pas : le prochain run
      // en creerait un second. L'id est logue pour rattrapage manuel.
      throw new Error(
        `evenement ${created} cree dans "${slot.label}" mais id non ecrit dans Notion ` +
        `(a supprimer a la main ou a recopier dans "${slot.eventIdProp}") : ${(err as Error).message}`,
      );
    }
    console.log(`  ${slot.label} : evenement cree le ${day} (${created})`);
    return "created";
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] ${slot.label} : mise a jour de ${eventId} au ${day}`);
    return "updated";
  }

  try {
    await patchEvent(slot, eventId, summary, day, url);
    console.log(`  ${slot.label} : evenement mis a jour au ${day} (${eventId})`);
    return "updated";
  } catch (err) {
    if (!isGone(err)) throw err;
    // Evenement supprime dans l'agenda alors que la date existe toujours :
    // Notion fait foi, on le recree et on reecrit l'id.
    const created = await createEvent(slot, summary, day, url);
    await writeText(page.id, slot.eventIdProp, created);
    console.log(`  ${slot.label} : evenement disparu, recree le ${day} (${eventId} -> ${created})`);
    return "recreated";
  }
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

  const day = today();
  const since = hoursAgo(LAST_EDITED_WINDOW_HOURS);

  console.log(`Sync du ${day} (${TIMEZONE}), taches modifiees depuis ${since}.`);
  if (DRY_RUN) console.log("Mode --dry-run : aucune ecriture.");
  console.log("");

  const pages = await queryAll(TASKS_DATABASE_ID, {
    and: [
      { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } },
      {
        or: [
          // Ce qu'il faut projeter...
          ...SLOTS.map((s) => ({ property: s.dateProp, date: { on_or_after: day } })),
          // ...et ce qu'il faut nettoyer, meme sans date ni echeance a venir.
          ...SLOTS.map((s) => ({ property: s.eventIdProp, rich_text: { is_not_empty: true } })),
        ],
      },
    ],
  });

  console.log(`${pages.length} tache(s) dans le perimetre.\n`);

  const tally: Record<Action, number> = {
    created: 0,
    updated: 0,
    deleted: 0,
    recreated: 0,
    untouched: 0,
  };
  let failed = 0;

  for (const page of pages) {
    const name = titleOf(page) || "(sans nom)";
    const actions: Action[] = [];

    console.log(`- "${name}"`);

    for (const slot of SLOTS) {
      try {
        const action = await syncSlot(page, slot, name);
        tally[action]++;
        actions.push(action);
      } catch (err) {
        // Un slot en echec n'empeche pas l'autre : chaque date est un lien
        // independant, et le run suivant reprendra celui qui a echoue.
        console.log(`  ECHEC ${slot.label} : ${(err as Error).message}`);
        failed++;
      }
    }

    if (actions.length === SLOTS.length && actions.every((a) => a === "untouched")) {
      console.log("  rien a faire");
    }
  }

  console.log(
    `\nTermine. ${tally.created} cree(s), ${tally.updated} mis a jour, ` +
    `${tally.recreated} recree(s), ${tally.deleted} supprime(s), ${failed} echec(s).`,
  );

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`Echec : ${(err as Error).message}`);
  process.exit(1);
});
