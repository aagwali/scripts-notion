#!/usr/bin/env -S npx tsx
/**
 * Report quotidien du calendrier Google "Post-it".
 *
 * Post-it recoit les actions eclair : un evenement dont le titre dit tout,
 * cree a la main, sans tache Notion derriere. Supprimer l'evenement vaut
 * "fait". Tout evenement encore present une fois sa journee passee n'a donc
 * pas ete fait : ce script le ramene sur aujourd'hui, jour apres jour,
 * jusqu'a ce qu'il soit supprime.
 *
 * L'evenement revient toujours en journee entiere, meme s'il portait une
 * heure : un creneau horaire appartient a sa journee, rien ne garantit qu'il
 * soit libre le lendemain. A replacer a la main si besoin.
 *
 * "Passe" veut dire termine avant minuit aujourd'hui, dans TIMEZONE. Un
 * evenement en cours ou a venir n'est jamais touche. Aucune fenetre de temps :
 * tout ce qui reste dans le passe du calendrier est par construction un
 * reliquat, et un run manque est rattrape par le suivant.
 *
 * Les evenements recurrents sont ignores (et logues) : les deplacer n'aurait
 * pas de sens, et une recurrence n'a rien d'une action eclair.
 *
 * Usage :
 *   npx tsx scripts/roll-post-it.ts [--dry-run]
 *
 * Variables d'environnement (.env) :
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *
 * Node >= 18 requis (fetch natif).
 */

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { instance } from "../config/index.ts";

// --- Config -----------------------------------------------------------

const CALENDAR_ID = instance.google.calendars.postIt;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Fuseau qui definit "aujourd'hui", independamment de celui du runner. */
const TIMEZONE = "Europe/Paris";

const DRY_RUN = process.argv.includes("--dry-run");

// --- Dates ------------------------------------------------------------

/** Jour courant (YYYY-MM-DD) dans TIMEZONE. en-CA formate en ISO. */
export function today(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Ancre a midi UTC : l'arithmetique en jours reste juste aux changements
 * d'heure, ou minuit local peut ne pas exister ou exister deux fois.
 */
export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * Instant de minuit, heure de TIMEZONE, au jour donne. Le decalage est lu a
 * 21h UTC la veille : les changements d'heure ont lieu vers 2-3h du matin,
 * donc minuit porte toujours le decalage de la soiree qui le precede.
 */
export function midnight(day: string): Date {
  const probe = new Date(`${addDays(day, -1)}T21:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, timeZoneName: "longOffset" })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")!.value; // "GMT+02:00", ou "GMT" pile
  const suffix = offset === "GMT" ? "Z" : offset.slice(3);
  return new Date(`${day}T00:00:00${suffix}`);
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  recurrence?: string[];
  recurringEventId?: string;
}

/**
 * Vrai si l'evenement est entierement termine avant minuit aujourd'hui.
 * Journee entiere : la fin Google est exclusive, donc une journee unique de
 * la veille finit a `today` et est passee. Horaire : on compare les instants.
 */
export function isPast(event: CalendarEvent, day: string): boolean {
  if (event.end.date) return event.end.date <= day;
  if (event.end.dateTime) return new Date(event.end.dateTime) <= midnight(day);
  return false;
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

async function calendar<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    throw new Error(`Calendar API ${resp.status} sur ${path} : ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

const eventsPath = `/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

/**
 * Tout ce qui commence avant minuit aujourd'hui. Le filtre fin (evenement
 * termine, pas seulement commence) est fait par isPast.
 */
async function listStartedBefore(limit: Date): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      timeMax: limit.toISOString(),
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await calendar<{ items?: CalendarEvent[]; nextPageToken?: string }>(
      `${eventsPath}?${params}`,
    );
    events.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return events;
}

/**
 * Ramene l'evenement sur `day`, en journee entiere. dateTime et timeZone sont
 * explicitement vides : sans cela, un evenement horaire garderait son heure.
 */
async function moveToDay(eventId: string, day: string): Promise<void> {
  const allDay = (date: string) => ({ date, dateTime: null, timeZone: null });
  await calendar(`${eventsPath}/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify({ start: allDay(day), end: allDay(addDays(day, 1)) }),
  });
}

// --- Main -----------------------------------------------------------------

async function main(): Promise<void> {
  const missing = [
    ["GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID],
    ["GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET],
    ["GOOGLE_REFRESH_TOKEN", GOOGLE_REFRESH_TOKEN],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    console.error(`Variables d'environnement manquantes : ${missing.join(", ")}`);
    process.exit(1);
  }

  const day = today();
  console.log(`Report Post-it du ${day} (${TIMEZONE}).`);
  if (DRY_RUN) console.log("Mode --dry-run : aucune ecriture.");
  console.log("");

  const events = await listStartedBefore(midnight(day));
  let moved = 0;
  let skipped = 0;
  let failed = 0;

  for (const event of events) {
    if (!isPast(event, day)) continue;

    const name = event.summary ?? "(sans titre)";
    const from = event.start.date ?? event.start.dateTime;

    if (event.recurrence || event.recurringEventId) {
      console.log(`- "${name}" : recurrent, ignore`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`- [dry-run] "${name}" : ${from} -> ${day}`);
      moved++;
      continue;
    }

    try {
      await moveToDay(event.id, day);
      console.log(`- "${name}" : ${from} -> ${day} (${event.id})`);
      moved++;
    } catch (err) {
      // Un evenement en echec n'empeche pas les autres ; le run suivant le reprendra.
      console.log(`- ECHEC "${name}" (${event.id}) : ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nTermine. ${moved} reporte(s), ${skipped} ignore(s), ${failed} echec(s).`);

  if (failed > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`Echec : ${(err as Error).message}`);
    process.exit(1);
  });
}
