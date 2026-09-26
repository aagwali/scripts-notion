#!/usr/bin/env -S npx tsx
/**
 * Tests de la frontiere "passe" de roll-post-it.
 *
 * Le script deplace tout evenement termine avant minuit, heure de Paris. Une
 * erreur d'un jour ou d'une heure deplacerait un evenement du jour, ou en
 * laisserait un de la veille : d'ou ces cas, changements d'heure compris,
 * qui n'appellent jamais Google.
 *
 * Usage : npx tsx scripts/roll-post-it.test.ts
 */

import assert from "node:assert/strict";
import { isPast, midnight, today, type CalendarEvent } from "./roll-post-it.ts";

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

const allDay = (start: string, end: string): CalendarEvent => ({
  id: "x",
  start: { date: start },
  end: { date: end },
});

const timed = (start: string, end: string): CalendarEvent => ({
  id: "x",
  start: { dateTime: start },
  end: { dateTime: end },
});

console.log("roll-post-it");

check("minuit en ete vaut 22h UTC la veille", () => {
  assert.equal(midnight("2026-09-27").toISOString(), "2026-09-26T22:00:00.000Z");
});

check("minuit en hiver vaut 23h UTC la veille", () => {
  assert.equal(midnight("2026-12-01").toISOString(), "2026-11-30T23:00:00.000Z");
});

check("minuit le jour du passage a l'heure d'ete garde l'heure d'hiver", () => {
  assert.equal(midnight("2026-03-29").toISOString(), "2026-03-28T23:00:00.000Z");
});

check("minuit le jour du retour a l'heure d'hiver garde l'heure d'ete", () => {
  assert.equal(midnight("2026-10-25").toISOString(), "2026-10-24T22:00:00.000Z");
});

check("aujourd'hui se lit a Paris, pas en UTC", () => {
  // 23h30 UTC le 26 = 1h30 le 27 a Paris.
  assert.equal(today(new Date("2026-09-26T23:30:00Z")), "2026-09-27");
});

check("journee entiere de la veille : passee", () => {
  assert.equal(isPast(allDay("2026-09-26", "2026-09-27"), "2026-09-27"), true);
});

check("journee entiere du jour : pas passee", () => {
  assert.equal(isPast(allDay("2026-09-27", "2026-09-28"), "2026-09-27"), false);
});

check("plusieurs jours debordant sur aujourd'hui : pas passe", () => {
  assert.equal(isPast(allDay("2026-09-25", "2026-09-28"), "2026-09-27"), false);
});

check("creneau horaire de la veille : passe", () => {
  assert.equal(isPast(timed("2026-09-26T13:00:00+02:00", "2026-09-26T13:30:00+02:00"), "2026-09-27"), true);
});

check("creneau horaire finissant pile a minuit : passe", () => {
  assert.equal(isPast(timed("2026-09-26T23:00:00+02:00", "2026-09-27T00:00:00+02:00"), "2026-09-27"), true);
});

check("creneau horaire a cheval sur minuit : pas passe", () => {
  assert.equal(isPast(timed("2026-09-26T23:30:00+02:00", "2026-09-27T00:30:00+02:00"), "2026-09-27"), false);
});

check("creneau horaire du jour, exprime en UTC la veille : pas passe", () => {
  // 22h30 UTC le 26 = 0h30 le 27 a Paris.
  assert.equal(isPast(timed("2026-09-26T22:30:00Z", "2026-09-26T23:00:00Z"), "2026-09-27"), false);
});

console.log(failures === 0 ? "\nTous les cas passent.\n" : `\n${failures} cas en echec.\n`);
process.exit(failures === 0 ? 0 : 1);
