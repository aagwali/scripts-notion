#!/usr/bin/env -S npx tsx
/**
 * Garde-fou CI : aucun identifiant Notion (UUID) ni id de calendrier Google
 * ne doit vivre ailleurs que dans `config/instance.json`. Un script qui a
 * besoin d'un id l'importe depuis `config/index.ts` -- voir CLAUDE.md.
 *
 * Usage :
 *   npx tsx scripts/check-hardcoded-ids.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** Repertoires jamais parcourus : config/ heberge legitimement les ids, le
 * reste est genere, historique ou hors perimetre du dedoublonnage. */
const EXCLUDED_DIRS = new Set(["config", "scripts/archive", "node_modules", ".git"]);

/** Extensions dont le contenu vaut la peine d'etre lu. */
const TEXT_EXTENSIONS = new Set([".ts", ".md", ".json", ".yml", ".yaml", ""]);

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CALENDAR_ID_RE = /\b[0-9a-f]{30,}@group\.calendar\.google\.com\b/gi;

interface Hit {
  file: string;
  line: number;
  match: string;
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (EXCLUDED_DIRS.has(rel)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listFiles(full));
    } else if (TEXT_EXTENSIONS.has(extname(full))) {
      files.push(full);
    }
  }
  return files;
}

function scan(file: string): Hit[] {
  const hits: Hit[] = [];
  const lines = readFileSync(file, "utf-8").split("\n");
  lines.forEach((line, i) => {
    for (const re of [UUID_RE, CALENDAR_ID_RE]) {
      for (const match of line.matchAll(re)) {
        hits.push({ file: relative(ROOT, file), line: i + 1, match: match[0] });
      }
    }
  });
  return hits;
}

const hits = listFiles(ROOT).flatMap(scan);

if (hits.length > 0) {
  console.error("Identifiants trouves hors de config/ :\n");
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line}  ${hit.match}`);
  }
  console.error(
    `\n${hits.length} occurrence(s). Deplacer ces ids dans config/instance.json et les lire via config/index.ts.`,
  );
  process.exit(1);
}

console.log("Aucun identifiant en dur hors de config/.");
