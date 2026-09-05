#!/usr/bin/env -S npx tsx
/**
 * Tests de la logique de decision de reset-recurring-events.
 *
 * Le coeur du script est un arbitrage a trois etats (compte / rompt / gele)
 * qui depend d'une comparaison de dates, donc invisible a la relecture et
 * couteux a verifier en production : une erreur ne se manifeste qu'une fois
 * la serie faussee. D'ou ces cas, qui n'appellent jamais Notion.
 *
 * Usage : npx tsx scripts/reset-recurring-events.test.ts
 */

import assert from "node:assert/strict";
import {
  addDays,
  decide,
  isMonthdayOn,
  previousOccurrence,
  weekdayOf,
  type Decision,
  type EventState,
} from "./reset-recurring-events.ts";

let failures = 0;

function check(name: string, run: () => void): void {
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${(err as Error).message.split("\n")[0]}`);
    failures++;
  }
}

/** Etat par defaut : quotidien, veille faite, serie a 3. */
function state(overrides: Partial<EventState> = {}): EventState {
  return {
    recurrence: "Quotidien",
    weekdays: [],
    monthday: null,
    done: true,
    series: 3,
    previousDay: "2026-09-04",
    ...overrides,
  };
}

function expect(decision: Decision, outcome: string, series: number | null): void {
  assert.equal(decision.outcome, outcome, `outcome (raison: ${decision.reason})`);
  assert.equal(decision.series, series, `series (raison: ${decision.reason})`);
}

// --- Calendrier ------------------------------------------------------------

console.log("\nCalendrier");

check("weekdayOf aligne sur les options Weekday", () => {
  assert.equal(weekdayOf("2026-09-04"), "Ven");
  assert.equal(weekdayOf("2026-09-05"), "Sam");
  assert.equal(weekdayOf("2026-09-06"), "Dim");
  assert.equal(weekdayOf("2026-09-07"), "Lun");
});

check("addDays franchit les mois et les annees", () => {
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29"); // annee bissextile
});

check("addDays franchit les changements d'heure sans deriver", () => {
  // Passage a l'heure d'ete (29/03/2026) et a l'heure d'hiver (25/10/2026)
  // en Europe/Paris : c'est la que l'ancrage a midi UTC se justifie.
  assert.equal(addDays("2026-03-28", 1), "2026-03-29");
  assert.equal(addDays("2026-03-29", 1), "2026-03-30");
  assert.equal(addDays("2026-10-24", 1), "2026-10-25");
  assert.equal(addDays("2026-10-25", 1), "2026-10-26");
});

const daily = { recurrence: "Quotidien", weekdays: [], monthday: null };
const weekly = (...weekdays: string[]) => ({ recurrence: "Hebdo", weekdays, monthday: null });
const monthly = (monthday: number | null) => ({ recurrence: "Mensuel", weekdays: [], monthday });

check("previousOccurrence quotidienne est la veille", () => {
  assert.equal(previousOccurrence("2026-09-05", daily), "2026-09-04");
});

check("previousOccurrence hebdo remonte a la semaine precedente", () => {
  // 07/09/2026 est un lundi.
  assert.equal(previousOccurrence("2026-09-07", weekly("Lun")), "2026-08-31");
});

check("previousOccurrence hebdo multi-jours prend la plus proche", () => {
  // Jeudi 10/09 pour un evenement Lun + Jeu : l'occurrence precedente est le
  // lundi 07, pas le jeudi d'avant.
  assert.equal(previousOccurrence("2026-09-10", weekly("Lun", "Jeu")), "2026-09-07");
});

check("previousOccurrence sans Weekday ne trouve rien", () => {
  assert.equal(previousOccurrence("2026-09-05", weekly()), null);
});

check("previousOccurrence mensuelle remonte au mois precedent", () => {
  assert.equal(previousOccurrence("2026-09-01", monthly(1)), "2026-08-01");
  assert.equal(previousOccurrence("2026-01-01", monthly(1)), "2025-12-01");
});

check("previousOccurrence mensuelle sans Monthday ne trouve rien", () => {
  assert.equal(previousOccurrence("2026-09-01", monthly(null)), null);
});

check("previousOccurrence mensuelle franchit un mois court", () => {
  // Un 31 mars : le mois precedent n'a pas de 31, l'occurrence est le 28.
  assert.equal(previousOccurrence("2026-03-31", monthly(31)), "2026-02-28");
  // ...et l'ecart de 31 jours est bien la borne de la remontee.
  assert.equal(previousOccurrence("2026-01-31", monthly(31)), "2025-12-31");
});

// --- Jour du mois ----------------------------------------------------------

console.log("\nJour du mois");

check("isMonthdayOn reconnait le jour exact", () => {
  assert.equal(isMonthdayOn("2026-09-01", 1), true);
  assert.equal(isMonthdayOn("2026-09-02", 1), false);
  assert.equal(isMonthdayOn("2026-09-15", 15), true);
});

check("un Monthday au-dela de la fin du mois tombe le dernier jour", () => {
  // Fevrier 2026 a 28 jours : un evenement cale sur le 31 y passe le 28,
  // plutot que de sauter le mois.
  assert.equal(isMonthdayOn("2026-02-28", 31), true);
  assert.equal(isMonthdayOn("2026-02-27", 31), false);
  // Annee bissextile : c'est le 29 qui recoit le report.
  assert.equal(isMonthdayOn("2028-02-29", 31), true);
  assert.equal(isMonthdayOn("2028-02-28", 31), false);
  // Mois de 30 jours.
  assert.equal(isMonthdayOn("2026-04-30", 31), true);
  // Mois de 31 jours : aucun report, le 30 n'est pas l'occurrence.
  assert.equal(isMonthdayOn("2026-05-30", 31), false);
  assert.equal(isMonthdayOn("2026-05-31", 31), true);
});

// --- Eligibilite -----------------------------------------------------------

console.log("\nEligibilite");

check("Sur demande n'est jamais traite", () => {
  expect(decide(state({ recurrence: "Sur demande" }), "2026-09-05"), "skipped", null);
});

check("En pause n'est jamais traite", () => {
  expect(decide(state({ recurrence: "En pause" }), "2026-09-05"), "skipped", null);
});

check("Externe n'est jamais traite, meme un jour programme", () => {
  // "Revue" : un run Claude en est proprietaire. Le script ne doit jamais
  // ecrire dessus, sinon les deux resets se marchent dessus.
  expect(decide(state({ recurrence: "Externe" }), "2026-09-05"), "skipped", null);
});

check("Recurrence vide est signalee, pas ignoree en silence", () => {
  expect(decide(state({ recurrence: null }), "2026-09-05"), "invalid", null);
});

check("Recurrence inconnue est signalee", () => {
  expect(decide(state({ recurrence: "Trimestriel" }), "2026-09-05"), "invalid", null);
});

check("Hebdo sans Weekday est signale, pas traite tous les jours", () => {
  expect(decide(state({ recurrence: "Hebdo", weekdays: [] }), "2026-09-05"), "invalid", null);
});

check("Hebdo hors de son jour n'est pas touche", () => {
  // 05/09/2026 est un samedi.
  const d = decide(state({ recurrence: "Hebdo", weekdays: ["Lun"] }), "2026-09-05");
  expect(d, "skipped", null);
});

check("Mensuel sans Monthday est signale, pas traite tous les jours", () => {
  expect(decide(state({ recurrence: "Mensuel", monthday: null }), "2026-09-01"), "invalid", null);
});

check("Monthday hors de 1-31 est signale", () => {
  // Sans garde-fou, ce jour ne tomberait jamais et l'evenement
  // disparaitrait de la vue en silence.
  expect(decide(state({ recurrence: "Mensuel", monthday: 0 }), "2026-09-01"), "invalid", null);
  expect(decide(state({ recurrence: "Mensuel", monthday: 32 }), "2026-09-01"), "invalid", null);
  expect(decide(state({ recurrence: "Mensuel", monthday: 1.5 }), "2026-09-01"), "invalid", null);
});

check("Mensuel hors de son jour n'est pas touche", () => {
  expect(decide(state({ recurrence: "Mensuel", monthday: 1 }), "2026-09-05"), "skipped", null);
});

// --- Arbitrage de la serie -------------------------------------------------

console.log("\nSerie");

check("quotidien fait la veille : +1", () => {
  expect(decide(state({ done: true, series: 3 }), "2026-09-05"), "counted", 4);
});

check("quotidien non fait la veille : remise a zero", () => {
  expect(decide(state({ done: false, series: 3 }), "2026-09-05"), "broken", 0);
});

check("deja traite aujourd'hui : page intacte (rejouabilite du double cron)", () => {
  expect(decide(state({ previousDay: "2026-09-05" }), "2026-09-05"), "skipped", null);
});

check("Date vide : initialisation a 0 sans crediter le Done present", () => {
  expect(decide(state({ previousDay: null, done: true, series: null }), "2026-09-05"), "initialised", 0);
});

check("run de minuit saute : serie gelee, ni +1 ni reset", () => {
  // Le cas du scenario mercredi/jeudi : Done=true date de mercredi, deja
  // arbitre, et jeudi n'a jamais ete propose dans la vue.
  expect(decide(state({ previousDay: "2026-09-03", done: true, series: 3 }), "2026-09-05"), "frozen", 3);
});

check("run saute avec Done=false : gele aussi, la serie n'est pas punie", () => {
  expect(decide(state({ previousDay: "2026-09-03", done: false, series: 3 }), "2026-09-05"), "frozen", 3);
});

check("gel normalise une Series vide a 0", () => {
  expect(decide(state({ previousDay: "2026-09-01", series: null }), "2026-09-05"), "frozen", 0);
});

check("Date dans le futur : signalee, jamais ecrasee", () => {
  expect(decide(state({ previousDay: "2026-09-09" }), "2026-09-05"), "invalid", null);
});

check("hebdo le bon jour, semaine precedente faite : +1", () => {
  // Lundi 07/09, occurrence precedente lundi 31/08.
  const s = state({ recurrence: "Hebdo", weekdays: ["Lun"], previousDay: "2026-08-31", done: true, series: 2 });
  expect(decide(s, "2026-09-07"), "counted", 3);
});

check("hebdo le bon jour, semaine precedente non faite : reset", () => {
  const s = state({ recurrence: "Hebdo", weekdays: ["Lun"], previousDay: "2026-08-31", done: false, series: 2 });
  expect(decide(s, "2026-09-07"), "broken", 0);
});

check("hebdo dont la Date pointe un jour non programme : gele", () => {
  // Typiquement un evenement bascule de Quotidien a Hebdo : sa Date est la
  // veille, pas l'occurrence hebdo attendue. On gele plutot que d'arbitrer.
  const s = state({ recurrence: "Hebdo", weekdays: ["Lun"], previousDay: "2026-09-06", series: 2 });
  expect(decide(s, "2026-09-07"), "frozen", 2);
});

check("mensuel le bon jour, mois precedent fait : +1", () => {
  const s = state({ recurrence: "Mensuel", monthday: 1, previousDay: "2026-08-01", done: true, series: 4 });
  expect(decide(s, "2026-09-01"), "counted", 5);
});

check("mensuel le bon jour, mois precedent non fait : reset", () => {
  const s = state({ recurrence: "Mensuel", monthday: 1, previousDay: "2026-08-01", done: false, series: 4 });
  expect(decide(s, "2026-09-01"), "broken", 0);
});

check("mensuel dont un run a saute : serie gelee", () => {
  // Le run du 1er aout n'est pas parti : Date est restee au 1er juillet.
  const s = state({ recurrence: "Mensuel", monthday: 1, previousDay: "2026-07-01", done: true, series: 4 });
  expect(decide(s, "2026-09-01"), "frozen", 4);
});

check("mensuel deja traite aujourd'hui : page intacte", () => {
  const s = state({ recurrence: "Mensuel", monthday: 1, previousDay: "2026-09-01" });
  expect(decide(s, "2026-09-01"), "skipped", null);
});

check("mensuel reporte en fevrier : la serie n'est pas rompue", () => {
  // Occurrence du 28 fevrier (report du 31), puis celle du 31 mars.
  const s = state({ recurrence: "Mensuel", monthday: 31, previousDay: "2026-02-28", done: true, series: 6 });
  expect(decide(s, "2026-03-31"), "counted", 7);
});

check("une serie longue survit a une panne puis reprend", () => {
  const gel = decide(state({ previousDay: "2026-08-20", done: true, series: 40 }), "2026-09-05");
  expect(gel, "frozen", 40);
  // Le lendemain, Date vaut 2026-09-05 : le cas nominal reprend.
  expect(decide(state({ previousDay: "2026-09-05", done: true, series: 40 }), "2026-09-06"), "counted", 41);
});

console.log(failures === 0 ? "\nTous les cas passent.\n" : `\n${failures} cas en echec.\n`);
process.exit(failures === 0 ? 0 : 1);
