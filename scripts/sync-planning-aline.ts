#!/usr/bin/env -S npx tsx
/**
 * Projection du planning d'Aline (base Notion "Planning Aline") vers Google
 * Calendar.
 *
 * Aline travaille une quinzaine de jours par mois, en deux horaires. Les
 * jours ou elle travaille, les trajets scolaires me reviennent et le
 * teletravail devient obligatoire : ce planning est donc une contrainte
 * sur MON agenda, pas une information sur le sien.
 *
 * Le planning n'existe que sous une seule forme, un tableau blanc rempli
 * au feutre. La photo en est lue par une tache Claude
 * (.claude/skills/planning-aline/), qui ecrit une ligne par jour dans la
 * base Notion puis declenche le workflow GitHub. Ce script ne connait que
 * la base -- il ne voit jamais la photo.
 *
 * Deux destinations :
 *
 *   Type = Travail   calendrier DEDIE "Planning Aline", journee entiere,
 *                    titre "H1 · 6h30-18h30"
 *   Type = RDV       calendrier PERSONNEL, journee entiere, ou horaire si
 *                    la date Notion porte une heure
 *
 * IDEMPOTENCE, et c'est tout le sujet du script. Le calendrier personnel
 * est tenu a la main : y reconcilier une fenetre de dates effacerait des
 * saisies manuelles. Chaque evenement ecrit porte donc un tag dans
 * `extendedProperties.private`, sur lequel `events.list` sait filtrer. Le
 * script devient proprietaire d'une fenetre VIRTUELLE a l'interieur du
 * calendrier, ou tout ce qui a ete saisi a la main est litteralement
 * invisible a la requete.
 *
 * Le meme mecanisme est applique au calendrier dedie, alors qu'il n'y
 * serait pas necessaire. C'est delibere : le planning est importe une
 * fois par mois puis retouche directement dans Google Calendar, jamais
 * dans Notion. Une reconciliation par fenetre ecraserait ces retouches au
 * premier re-run venu -- relance d'un run echoue, double declenchement du
 * workflow. Le regime par defaut est donc le meme des deux cotes :
 *
 *   SENS UNIQUE   le tag sert uniquement a ne pas creer deux fois. Un
 *                 evenement deja pose n'est ni modifie ni supprime, quoi
 *                 qu'en dise Notion.
 *
 * L'inverse -- Notion reprend la main, les evenements tagues sont alignes
 * et les orphelins supprimes -- reste accessible par `--reconcile`. Il
 * sert au cas ou la photo a ete mal lue : on corrige la base, on relance
 * en reconciliation, l'agenda suit. C'est un geste explicite parce qu'il
 * detruit des retouches manuelles.
 *
 * La requete des evenements tagues n'a volontairement aucune borne de
 * date : elle filtre sur le seul tag de mois. Un evenement deplace a la
 * main hors du mois reste donc trouve, et n'est pas recree en double.
 *
 * Le mois courant est calcule dans TIMEZONE, pas dans le fuseau du
 * runner -- un runner GitHub est en UTC et se tromperait de mois le 1er a
 * minuit.
 *
 * Usage :
 *   npx tsx scripts/sync-planning-aline.ts [--month YYYY-MM] [--reconcile] [--dry-run]
 *
 * Variables d'environnement (.env) :
 *   NOTION_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *
 * Node >= 18 requis (fetch natif).
 */

import "dotenv/config";

// --- Config -----------------------------------------------------------

const PLANNING_DATABASE_ID = "8042d9c1-3ea1-481d-a64e-b48d9a138f19"; // Planning Aline

/**
 * Calendrier dedie "Planning Aline", cree a la main dans l'UI Google
 * Calendar : le scope `calendar.events` permet d'ecrire des evenements,
 * pas de creer un calendrier.
 */
const PLANNING_CALENDAR_ID =
  "affbc5703ccd88c8fd08e946acf97e75cd87896faea2411eda2c7f31c8971b4e@group.calendar.google.com";

/** Calendrier personnel, tenu a la main, ou atterrissent les rdv annexes. */
const PERSONAL_CALENDAR_ID = "adrienagwali@gmail.com";

/**
 * Les horaires vivent ici et pas dans Notion : le tableau blanc ne porte
 * que les codes, et une base qui repeterait "6h30-18h30" sur treize
 * lignes finirait par se contredire.
 */
const SHIFTS: Record<string, string> = {
  H1: "6h30-18h30",
  H2: "7h30-19h30",
};

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2022-06-28";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Fuseau qui definit "le mois courant", independamment de celui du runner. */
const TIMEZONE = "Europe/Paris";

/** Duree d'un rdv dont la date Notion porte une heure. */
const APPOINTMENT_MINUTES = 60;

/** Cles du tag pose sur chaque evenement ecrit par le script. */
const TAG_MONTH = "planningAlineMonth";
const TAG_KEY = "planningAlineKey";

const DRY_RUN = process.argv.includes("--dry-run");
const RECONCILE = process.argv.includes("--reconcile");

const THROTTLE_MS = 350; // limite Notion ~3 req/s
const MAX_RETRIES = 4;

// --- Notion -------------------------------------------------------------

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
        sorts: [{ property: "Date", direction: "ascending" }],
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });

    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
  } while (cursor);

  return pages;
}

function titleOf(page: NotionPage): string {
  return (page.properties["Name"]?.title ?? [])
    .map((t: { plain_text: string }) => t.plain_text)
    .join("")
    .trim();
}

function selectOf(page: NotionPage, prop: string): string | null {
  return page.properties[prop]?.select?.name ?? null;
}

// --- Le planning d'un mois ----------------------------------------------

interface Entry {
  /** Jour, YYYY-MM-DD. */
  date: string;
  /** Heure locale HH:MM si la date Notion en porte une, null sinon. */
  time: string | null;
  /** Code horaire pour un jour travaille, null pour un rdv. */
  shift: string | null;
  /** Libelle Notion, utilise tel quel pour les rdv. */
  name: string;
}

/**
 * Lit le mois dans Notion et refuse tout ce qui n'est pas exploitable.
 * Les erreurs sont collectees puis levees d'un bloc : une lecture de photo
 * qui derape se corrige mieux avec la liste complete qu'avec la premiere
 * ligne fautive.
 */
async function loadMonth(month: string): Promise<{ work: Entry[]; appointments: Entry[] }> {
  const first = `${month}-01`;
  const last = lastDayOf(month);

  const pages = await queryAll(PLANNING_DATABASE_ID, {
    and: [
      { property: "Date", date: { on_or_after: first } },
      { property: "Date", date: { on_or_before: last } },
    ],
  });

  const errors: string[] = [];
  const work: Entry[] = [];
  const appointments: Entry[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    const name = titleOf(page) || "(sans nom)";
    const start = page.properties["Date"]?.date?.start;
    const type = selectOf(page, "Type");
    const shift = selectOf(page, "Horaire");

    if (typeof start !== "string") {
      errors.push(`"${name}" : pas de date`);
      continue;
    }

    const date = start.slice(0, 10);
    // Notion ne renvoie l'heure que si elle a ete saisie : sa presence
    // dans la chaine est le seul marqueur "evenement horaire".
    const time = start.length > 10 ? start.slice(11, 16) : null;

    if (type === "Travail") {
      if (shift === null || SHIFTS[shift] === undefined) {
        errors.push(`"${name}" (${date}) : horaire "${shift ?? "vide"}" absent ou inconnu`);
        continue;
      }
      if (seen.has(date)) {
        errors.push(`${date} : deux jours travailles sur la meme date`);
        continue;
      }
      seen.add(date);
      work.push({ date, time: null, shift, name });
      continue;
    }

    if (type === "RDV") {
      appointments.push({ date, time, shift: null, name });
      continue;
    }

    errors.push(`"${name}" (${date}) : Type "${type ?? "vide"}" inconnu, attendu Travail ou RDV`);
  }

  if (errors.length > 0) {
    throw new Error(`Base "Planning Aline" incoherente sur ${month} :\n  - ${errors.join("\n  - ")}`);
  }

  return { work, appointments };
}

// --- Google Calendar ----------------------------------------------------

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

interface GEvent {
  id: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

interface EventList {
  items: GEvent[];
  nextPageToken?: string;
}

/** Tous les evenements du mois ecrits par le script, indexes par cle de tag. */
async function listTagged(calendarId: string, month: string): Promise<Map<string, GEvent>> {
  const byKey = new Map<string, GEvent>();
  let pageToken: string | undefined;

  do {
    const query = new URLSearchParams({
      singleEvents: "true",
      showDeleted: "false",
      maxResults: "2500",
      privateExtendedProperty: `${TAG_MONTH}=${month}`,
      ...(pageToken ? { pageToken } : {}),
    });

    const page = await calendar<EventList>(
      `/calendars/${encodeURIComponent(calendarId)}/events?${query}`,
    );

    for (const event of page?.items ?? []) {
      const key = event.extendedProperties?.private?.[TAG_KEY];
      if (key !== undefined) byKey.set(key, event);
    }
    pageToken = page?.nextPageToken;
  } while (pageToken);

  return byKey;
}

async function insertEvent(calendarId: string, body: unknown): Promise<void> {
  await calendar(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function patchEvent(calendarId: string, eventId: string, body: unknown): Promise<void> {
  await calendar(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
  try {
    await calendar(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE" },
    );
  } catch (err) {
    // Deja disparu cote Google : le resultat voulu est atteint.
    const gone = err instanceof CalendarError && (err.status === 404 || err.status === 410);
    if (!gone) throw err;
  }
}

// --- Calendrier ---------------------------------------------------------

/** Mois courant (YYYY-MM) dans TIMEZONE. en-CA formate en ISO. */
function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
  }).format(new Date()).slice(0, 7);
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

/** Dernier jour du mois, sous forme YYYY-MM-DD. */
function lastDayOf(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
}

const WEEKDAYS = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];

/** Jour de la semaine, affiche a cote de chaque date pour relecture humaine. */
function weekdayOf(day: string): string {
  return WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
}

// --- Ce qu'on veut voir dans l'agenda ------------------------------------

/** Un evenement voulu, avec sa cle de tag et son corps Google. */
interface Wanted {
  key: string;
  label: string;
  body: Record<string, unknown>;
}

function allDay(summary: string, day: string) {
  return {
    summary,
    // Une journee entiere Google se decrit par des dates nues, avec une fin
    // EXCLUSIVE : une journee unique va de J a J+1.
    start: { date: day },
    end: { date: addDays(day, 1) },
  };
}

function tag(month: string, key: string) {
  return { extendedProperties: { private: { [TAG_MONTH]: month, [TAG_KEY]: key } } };
}

/** Jour travaille : la cle est la date, il n'y en a qu'un par jour. */
function wantedWorkDay(month: string, entry: Entry): Wanted {
  const summary = `${entry.shift} · ${SHIFTS[entry.shift!]}`;
  const key = `${month}:jour:${entry.date}`;
  return {
    key,
    label: `${entry.date} (${weekdayOf(entry.date)}) "${summary}"`,
    body: { ...allDay(summary, entry.date), ...tag(month, key) },
  };
}

/**
 * Rdv : la cle ne depend que du libelle, PAS de la date. Un rdv redate a
 * la main reste reconnu, et un rdv redate dans Notion n'est pas reimporte
 * en double. Deux rdv homonymes dans le meme mois se confondent --
 * acceptable pour quelques lignes, et le run le signale.
 */
function wantedAppointment(month: string, entry: Entry): Wanted {
  const slug = entry.name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const key = `${month}:rdv:${slug}`;
  const when = entry.time ? `${entry.date} ${entry.time}` : entry.date;
  const label = `${when} (${weekdayOf(entry.date)}) "${entry.name}"`;

  if (entry.time === null) {
    return { key, label, body: { ...allDay(entry.name, entry.date), ...tag(month, key) } };
  }

  const [hours, minutes] = entry.time.split(":").map(Number);
  const end = new Date(Date.UTC(2000, 0, 1, hours, minutes + APPOINTMENT_MINUTES));

  return {
    key,
    label,
    body: {
      summary: entry.name,
      // Dates locales + timeZone : Google resout l'offset, y compris au
      // changement d'heure. Pas d'arithmetique UTC a faire ici.
      start: { dateTime: `${entry.date}T${entry.time}:00`, timeZone: TIMEZONE },
      end: {
        dateTime: `${entry.date}T${end.toISOString().slice(11, 16)}:00`,
        timeZone: TIMEZONE,
      },
      ...tag(month, key),
    },
  };
}

// --- Application a un calendrier -----------------------------------------

interface Tally {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
}

/**
 * Pose dans `calendarId` les evenements voulus, sans jamais toucher a ce
 * qui n'est pas tague. En mode par defaut le travail s'arrete la : un
 * evenement deja pose est laisse tel quel, retouches manuelles comprises.
 * `--reconcile` va plus loin et aligne l'agenda sur Notion.
 */
async function apply(
  calendarId: string,
  month: string,
  wanted: Wanted[],
  tally: Tally,
): Promise<void> {
  const existing = await listTagged(calendarId, month);
  const claimed = new Set<string>();

  for (const item of wanted) {
    if (claimed.has(item.key)) {
      console.log(`  ! ${item.label} : cle "${item.key}" deja prise, ligne ignoree`);
      continue;
    }
    claimed.add(item.key);

    const already = existing.get(item.key);

    if (already === undefined) {
      if (DRY_RUN) {
        console.log(`  [dry-run] ${item.label} : creation`);
      } else {
        await insertEvent(calendarId, item.body);
        console.log(`  ${item.label} : cree`);
      }
      tally.created++;
      continue;
    }

    if (!RECONCILE) {
      console.log(`  ${item.label} : deja pose, laisse tel quel`);
      tally.skipped++;
      continue;
    }

    if (already.summary === item.body.summary) {
      tally.skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [dry-run] ${item.label} : "${already.summary}" mis a jour`);
    } else {
      await patchEvent(calendarId, already.id, item.body);
      console.log(`  ${item.label} : "${already.summary}" mis a jour`);
    }
    tally.updated++;
  }

  if (!RECONCILE) return;

  // Tague, mais plus dans Notion : la ligne a ete supprimee de la base.
  for (const [key, event] of existing) {
    if (claimed.has(key)) continue;
    if (DRY_RUN) {
      console.log(`  [dry-run] "${event.summary}" (${key}) : suppression`);
    } else {
      await deleteEvent(calendarId, event.id);
      console.log(`  "${event.summary}" (${key}) : supprime`);
    }
    tally.deleted++;
  }
}

// --- Main ----------------------------------------------------------------

function readMonthArg(): string {
  const index = process.argv.indexOf("--month");
  if (index === -1) return currentMonth();

  const value = process.argv[index + 1];
  if (value === undefined || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error(`--month attend un mois au format YYYY-MM, recu "${value ?? ""}"`);
  }
  return value;
}

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

  const month = readMonthArg();
  const { work, appointments } = await loadMonth(month);

  console.log(
    `Planning ${month} : ${work.length} jour(s) travaille(s), ${appointments.length} rdv.`,
  );
  console.log(
    RECONCILE
      ? "Mode --reconcile : Notion fait foi, les retouches manuelles sur les evenements tagues sautent."
      : "Import a sens unique : rien de deja pose n'est modifie ni supprime.",
  );
  if (DRY_RUN) console.log("Mode --dry-run : aucune ecriture.");

  const tally: Tally = { created: 0, updated: 0, deleted: 0, skipped: 0 };

  console.log("\nJours travailles (calendrier dedie) :");
  await apply(PLANNING_CALENDAR_ID, month, work.map((e) => wantedWorkDay(month, e)), tally);

  console.log("\nRendez-vous (calendrier personnel) :");
  if (appointments.length === 0) {
    console.log("  aucun");
  } else {
    await apply(
      PERSONAL_CALENDAR_ID,
      month,
      appointments.map((e) => wantedAppointment(month, e)),
      tally,
    );
  }

  console.log(
    `\nTermine. ${tally.created} cree(s), ${tally.updated} mis a jour, ` +
    `${tally.deleted} supprime(s), ${tally.skipped} inchange(s).`,
  );
}

main().catch((err) => {
  console.error(`Echec : ${(err as Error).message}`);
  process.exit(1);
});
