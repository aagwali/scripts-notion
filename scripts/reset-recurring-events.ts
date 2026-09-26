#!/usr/bin/env -S npx tsx
/**
 * Reset de minuit sur la base Notion "Recurring events".
 *
 * A chaque passage de minuit, les evenements programmes ce jour-la sont
 * reamorces pour la journee qui commence : Done decoche, Date au jour
 * courant. La vue "Daily" filtre sur (Date = aujourd'hui ET Done = false) :
 * cette seule ecriture suffit donc a composer la liste du jour, et un
 * evenement non programme aujourd'hui disparait de lui-meme.
 *
 * La propriete Series compte les occurrences consecutives reussies. Le run
 * arbitre la journee qui vient de s'ecouler : le Done qu'il lit est le clic
 * de l'occurrence precedente, jamais celui du jour qui commence.
 *
 * La propriete Recurrence pilote seule l'eligibilite. Type (Dashboard,
 * Reminder) decrit la nature d'une serie, pas une regle de planification :
 * le script ne le lit pas.
 *
 *   Quotidien   : traite tous les jours
 *   Hebdo       : traite uniquement les jours coches dans Weekday
 *   Mensuel     : traite uniquement le jour du mois indique par Monthday
 *   Sur demande : jamais traite (declenche a la main)
 *   En pause    : jamais traite, gele en l'etat
 *   Externe     : jamais traite, un autre processus en est proprietaire
 *   (vide)      : jamais traite, signale dans le log
 *
 * Series, selon ce que la propriete Date revele du run precedent :
 *
 *   Date == aujourd'hui  deja passe aujourd'hui, page laissee intacte.
 *                        C'est la garantie de rejouabilite qui permet au cron
 *                        et a un lancement manuel de coexister.
 *
 *   Date == occurrence   cas nominal, le Done lu se rapporte bien a
 *   attendue             l'occurrence precedente : Done ? Series + 1 : 0
 *
 *   Date plus ancienne   un run de minuit a saute. La journee manquante
 *                        n'a jamais ete affichee dans la vue, donc ni
 *                        reussie ni echouee, et le Done lu se rapporte a
 *                        une occurrence deja arbitree : Series est gelee.
 *                        Une panne d'infra ne casse pas une serie, et ne
 *                        peut pas non plus la gonfler.
 *
 *   Date vide            premiere prise en charge : Series = 0
 *
 * Le jour de reference est calcule dans TIMEZONE, pas dans le fuseau du
 * runner : un runner GitHub est en UTC et se trompe d'un jour a minuit.
 *
 * Usage :
 *   npx tsx scripts/reset-recurring-events.ts [--dry-run]
 *
 * Variables d'environnement (.env) : NOTION_TOKEN
 *
 * Node >= 18 requis (fetch natif).
 */

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { instance } from "../config/index.ts";

// --- Config -----------------------------------------------------------

const RECURRING_DATABASE_ID = instance.notion.databases.recurringEvents.database_id;

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2022-06-28";

/** Fuseau qui definit "aujourd'hui", independamment de celui du runner. */
const TIMEZONE = "Europe/Paris";

const RECURRENCE_PROP = "Recurrence";
const WEEKDAY_PROP = "Weekday";
const MONTHDAY_PROP = "Monthday";
const DONE_PROP = "Done";
const SERIES_PROP = "Series";
const DATE_PROP = "Date";

/**
 * Valeurs de Recurrence qui excluent l'evenement du reset, chacune pour une
 * raison distincte -- le log reprend la valeur telle quelle.
 *
 *   Sur demande : declenche a la main, n'a pas de rythme
 *   En pause    : rythme suspendu, gele en l'etat
 *   Externe     : un autre processus fait deja le reset de cette page. Cas
 *                 de "Revue", reinitialisee par un run Claude : deux resets
 *                 sur la meme page se marcheraient dessus, celui qui passe
 *                 en premier posant Date au jour courant et faisant conclure
 *                 "deja traite" a l'autre, sans arbitrage de Series.
 */
const EXCLUDED_RECURRENCES = ["Sur demande", "En pause", "Externe"];

/** Valeurs que ce script sait planifier ; toute autre est une erreur de saisie. */
const SCHEDULED_RECURRENCES = ["Quotidien", "Hebdo", "Mensuel"];

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
  properties: Record<string, any>;
}

interface QueryResponse {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * La base tient en quelques dizaines de lignes : on la lit entierement
 * plutot que de filtrer cote Notion, pour pouvoir tracer dans le log
 * pourquoi chaque evenement a ete ecarte.
 */
async function queryAll(databaseId: string): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;

  do {
    const data = await notion<QueryResponse>(`/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
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

function selectNameOf(page: NotionPage, prop: string): string | null {
  return page.properties[prop]?.select?.name ?? null;
}

function multiSelectNamesOf(page: NotionPage, prop: string): string[] {
  return (page.properties[prop]?.multi_select ?? []).map((o: { name: string }) => o.name);
}

function checkboxOf(page: NotionPage, prop: string): boolean {
  return page.properties[prop]?.checkbox === true;
}

function numberOf(page: NotionPage, prop: string): number | null {
  return page.properties[prop]?.number ?? null;
}

/**
 * Seule la partie calendaire compte. Notion peut renvoyer un datetime si la
 * date a ete saisie a la main avec une heure : on tronque, ce qui conserve
 * le jour tel qu'il s'affiche dans Notion.
 */
function dayOf(page: NotionPage, prop: string): string | null {
  const start = page.properties[prop]?.date?.start;
  return typeof start === "string" ? start.slice(0, 10) : null;
}

// --- Calendrier ------------------------------------------------------------

/** Indexe par getUTCDay(), et aligne sur les options du select Weekday. */
const WEEKDAYS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"] as const;

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
function parseDay(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

export function addDays(day: string, delta: number): string {
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(day: string): string {
  return WEEKDAYS[parseDay(day).getUTCDay()];
}

/** Nombre de jours du mois auquel `day` appartient. */
function daysInMonthOf(day: string): number {
  const d = parseDay(day);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Un Monthday au-dela de la fin du mois est ramene au dernier jour : un
 * evenement cale sur le 31 tombe le 28 en fevrier plutot que de sauter le
 * mois. Choisi parce qu'un rappel mensuel doit passer douze fois par an --
 * sauter fevrier serait un trou silencieux, et le gel de Series qui suit
 * ferait croire a une panne.
 */
export function isMonthdayOn(day: string, monthday: number): boolean {
  return parseDay(day).getUTCDate() === Math.min(monthday, daysInMonthOf(day));
}

/** Ce qui suffit a dire si un jour est programme. Sous-ensemble d'EventState. */
export interface Schedule {
  recurrence: string;
  weekdays: string[];
  monthday: number | null;
}

function isScheduledOn(day: string, schedule: Schedule): boolean {
  if (schedule.recurrence === "Quotidien") return true;
  if (schedule.recurrence === "Hebdo") return schedule.weekdays.includes(weekdayOf(day));
  if (schedule.recurrence === "Mensuel") {
    return schedule.monthday !== null && isMonthdayOn(day, schedule.monthday);
  }
  return false;
}

/**
 * Occurrence programmee juste avant `day`. C'est elle que le Done lu est
 * cense decrire ; toute autre valeur de Date signale un run manque.
 *
 * Remonte au plus 31 jours : c'est le pire ecart entre deux occurrences
 * mensuelles (un 31 janvier suivi d'un 28 fevrier ramene). Un Hebdo trouve
 * de toute facon dans les 7 premiers jours.
 */
export function previousOccurrence(day: string, schedule: Schedule): string | null {
  for (let back = 1; back <= 31; back++) {
    const candidate = addDays(day, -back);
    if (isScheduledOn(candidate, schedule)) return candidate;
  }
  return null;
}

// --- Traitement d'un evenement ---------------------------------------------

export type Outcome = "counted" | "broken" | "frozen" | "initialised" | "skipped" | "invalid";

export interface Decision {
  outcome: Outcome;
  /** Series a ecrire ; null quand la page ne doit pas etre touchee. */
  series: number | null;
  reason: string;
}

/** Etat d'un evenement, extrait de la page Notion. */
export interface EventState {
  recurrence: string | null;
  weekdays: string[];
  monthday: number | null;
  done: boolean;
  series: number | null;
  /** Jour du dernier reset, c'est-a-dire l'occurrence que `done` decrit. */
  previousDay: string | null;
}

export function readState(page: NotionPage): EventState {
  return {
    recurrence: selectNameOf(page, RECURRENCE_PROP),
    weekdays: multiSelectNamesOf(page, WEEKDAY_PROP),
    monthday: numberOf(page, MONTHDAY_PROP),
    done: checkboxOf(page, DONE_PROP),
    series: numberOf(page, SERIES_PROP),
    previousDay: dayOf(page, DATE_PROP),
  };
}

export function decide(state: EventState, day: string): Decision {
  const { recurrence, weekdays, monthday, series, done, previousDay } = state;

  if (recurrence === null) {
    return { outcome: "invalid", series: null, reason: `${RECURRENCE_PROP} vide` };
  }
  if (EXCLUDED_RECURRENCES.includes(recurrence)) {
    return { outcome: "skipped", series: null, reason: recurrence };
  }
  if (!SCHEDULED_RECURRENCES.includes(recurrence)) {
    return { outcome: "invalid", series: null, reason: `${RECURRENCE_PROP} inconnue "${recurrence}"` };
  }
  if (recurrence === "Hebdo" && weekdays.length === 0) {
    return { outcome: "invalid", series: null, reason: `Hebdo sans ${WEEKDAY_PROP}` };
  }
  if (recurrence === "Mensuel" && monthday === null) {
    return { outcome: "invalid", series: null, reason: `Mensuel sans ${MONTHDAY_PROP}` };
  }
  if (
    recurrence === "Mensuel" &&
    (!Number.isInteger(monthday) || monthday! < 1 || monthday! > 31)
  ) {
    // Sans ce garde-fou un 0 ou un 32 ne tomberait jamais : l'evenement
    // disparaitrait de la vue sans que rien ne le signale.
    return {
      outcome: "invalid",
      series: null,
      reason: `${MONTHDAY_PROP} hors de 1-31 (${monthday})`,
    };
  }

  const schedule: Schedule = { recurrence, weekdays, monthday };

  if (!isScheduledOn(day, schedule)) {
    const rythme =
      recurrence === "Mensuel"
        ? `le ${monthday} du mois`
        : `un ${weekdayOf(day)} (${weekdays.join(", ")})`;
    return { outcome: "skipped", series: null, reason: `pas programme ${rythme}` };
  }

  if (previousDay === day) {
    return { outcome: "skipped", series: null, reason: "deja traite aujourd'hui" };
  }
  if (previousDay !== null && previousDay > day) {
    // Date dans le futur : saisie manuelle ou horloge decalee. Ecraser
    // ferait perdre une information qu'on ne sait pas interpreter.
    return { outcome: "invalid", series: null, reason: `${DATE_PROP} dans le futur (${previousDay})` };
  }
  if (previousDay === null) {
    return { outcome: "initialised", series: 0, reason: `${DATE_PROP} vide` };
  }

  const expected = previousOccurrence(day, schedule);

  if (previousDay !== expected) {
    // Ni +1 ni remise a zero : le Done lu decrit une occurrence deja
    // arbitree, et les jours ecoules depuis n'ont jamais ete proposes.
    return {
      outcome: "frozen",
      series: series ?? 0,
      reason: `run manque (${DATE_PROP} ${previousDay}, attendu ${expected})`,
    };
  }

  return done
    ? { outcome: "counted", series: (series ?? 0) + 1, reason: `${previousDay} fait` }
    : { outcome: "broken", series: 0, reason: `${previousDay} non fait` };
}

async function applyDecision(page: NotionPage, day: string, decision: Decision): Promise<void> {
  await notion(`/pages/${page.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        [DONE_PROP]: { checkbox: false },
        [SERIES_PROP]: { number: decision.series },
        [DATE_PROP]: { date: { start: day } },
      },
    }),
  });
}

// --- Main -----------------------------------------------------------------

async function main(): Promise<void> {
  if (!NOTION_TOKEN) {
    console.error("NOTION_TOKEN manquant (export NOTION_TOKEN=secret_xxx)");
    process.exit(1);
  }

  const day = today();
  console.log(`Reset du ${day} (${weekdayOf(day)}, ${TIMEZONE}).`);
  if (DRY_RUN) console.log("Mode --dry-run : aucune ecriture.");
  console.log("");

  const pages = await queryAll(RECURRING_DATABASE_ID);
  console.log(`${pages.length} evenement(s) dans la base.\n`);

  const tally: Record<Outcome, number> = {
    counted: 0,
    broken: 0,
    frozen: 0,
    initialised: 0,
    skipped: 0,
    invalid: 0,
  };
  let failed = 0;

  for (const page of pages) {
    const name = titleOf(page) || "(sans nom)";
    const state = readState(page);
    const decision = decide(state, day);
    tally[decision.outcome]++;

    if (decision.series === null) {
      const level = decision.outcome === "invalid" ? "IGNORE" : "ignore";
      console.log(`- ${level} "${name}" : ${decision.reason}`);
      continue;
    }

    const change =
      `Series ${state.series ?? "(vide)"} -> ${decision.series}, ` +
      `${DONE_PROP}=false, ${DATE_PROP}=${day}`;

    if (DRY_RUN) {
      console.log(`- [dry-run] "${name}" (${decision.outcome}, ${decision.reason}) : ${change}`);
      continue;
    }

    try {
      await applyDecision(page, day, decision);
      console.log(`- ok "${name}" (${decision.outcome}, ${decision.reason}) : ${change}`);
    } catch (err) {
      // La page reste en l'etat : Date inchangee, donc le prochain run la
      // verra comme un trou et gelera la Series plutot que de la fausser.
      console.log(`- ECHEC "${name}" : ${(err as Error).message}`);
      tally[decision.outcome]--;
      failed++;
    }
  }

  console.log(
    `\nTermine. ${tally.counted} serie(s) prolongee(s), ${tally.broken} rompue(s), ` +
    `${tally.frozen} gelee(s), ${tally.initialised} initialisee(s), ` +
    `${tally.skipped} ignore(s), ${tally.invalid} mal configure(s), ${failed} echec(s).`,
  );

  if (failed > 0 || tally.invalid > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
