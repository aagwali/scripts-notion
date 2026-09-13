#!/usr/bin/env -S npx tsx
/**
 * Ingestion des emails du dossier inbound (OneDrive / Power Automate) vers la
 * base Notion "Raw emails", puis archivage des fichiers traites.
 *
 * Version degradee "best effort" : pas d'URL de message, pas de labels, pas
 * d'en-tete List-Unsubscribe — Outlook Pro n'expose rien de tout cela via le
 * flux Power Automate. Le discriminant cote tache A est Source = "Reply".
 *
 * En-tetes attendus en tete de fichier, suivis d'une ligne vide :
 *   De: ...
 *   Objet: ...
 *   Reçu: ...
 *   Message ID: @{triggerOutputs()?['body/internetMessageId']}
 *   Thread ID: @{triggerOutputs()?['body/conversationId']}
 *
 * Usage :
 *   npm install tsx dotenv
 *   export NOTION_TOKEN="secret_xxx"
 *   npx tsx email-to-notion-input-outlook.ts
 *
 * Node >= 18 requis (fetch natif).
 */

import "dotenv/config";
import { promises as fs } from "fs";
import * as path from "path";

// --- Config -----------------------------------------------------------

const INBOUND_DIR =
  "/Users/a.agwali/Library/CloudStorage/OneDrive-Reply/emails/inbound";
const ARCHIVE_DIR = path.join(path.dirname(INBOUND_DIR), "archive");

const NOTION_DATABASE_ID = "ba36c9eb-2587-49e0-abd3-0d47276511c0"; // Raw emails
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2022-06-28";

const RICH_TEXT_CHUNK = 2000; // limite Notion par objet rich_text
const RICH_TEXT_MAX_CHUNKS = 100; // limite Notion par propriete (~200 000 car.)

// --- Parsing ------------------------------------------------------------

interface ParsedEmail {
  from: string;
  subject: string;
  received: string; // ISO 8601
  messageId: string;
  threadId: string;
  body: string;
  meetingStart: string;
  meetingEnd: string;
  meetingLocation: string;
  meetingRecurrence: string;
  meetingTimezone: string;
}

/** Cle d'en-tete -> champ. Tolerant a l'ordre et aux en-tetes absents. */
const HEADER_KEYS: Record<string, keyof ParsedEmail> = {
  de: "from",
  from: "from",
  objet: "subject",
  subject: "subject",
  "reçu": "received",
  recu: "received",
  received: "received",
  "message id": "messageId",
  "message-id": "messageId",
  "thread id": "threadId",
  "thread-id": "threadId",
  "meeting start": "meetingStart",
  "meeting end": "meetingEnd",
  "meeting location": "meetingLocation",
  "meeting recurrence": "meetingRecurrence",
  "meeting timezone": "meetingTimezone",
};

const HEADER_LINE_RE = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ -]{0,20}):\s*(.*)$/;

function parseEmailFile(raw: string, fileNameStem: string, mtime: Date): ParsedEmail {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const found: Partial<Record<keyof ParsedEmail, string>> = {};
  let bodyStart = 0;
  let sawHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Ligne vide : fin du bloc d'en-tetes des lors qu'on en a lu au moins un.
    if (line.trim() === "") {
      if (sawHeader) {
        bodyStart = i + 1;
        break;
      }
      continue;
    }

    const match = line.match(HEADER_LINE_RE);
    const field = match ? HEADER_KEYS[match[1].trim().toLowerCase()] : undefined;

    if (!field) {
      // Ligne non reconnue : on considere que le corps commence ici.
      bodyStart = i;
      break;
    }

    found[field] = match![2].trim();
    sawHeader = true;
    bodyStart = i + 1;
  }

  if (!sawHeader) {
    console.log(`  ! aucun en-tete reconnu, fallback brut pour ${fileNameStem}`);
    return {
      from: "",
      subject: fileNameStem,
      received: mtime.toISOString(),
      messageId: "",
      threadId: "",
      meetingStart: "",
      meetingEnd: "",
      meetingLocation: "",
      meetingRecurrence: "",
      body: normalized.trim(),
      meetingTimezone: ""
    };
  }

  const parsedDate = new Date(found.received ?? "");
  const received = isNaN(parsedDate.getTime()) ? mtime.toISOString() : parsedDate.toISOString();

  return {
    from: found.from ?? "",
    subject: found.subject || fileNameStem,
    received,
    messageId: found.messageId ?? "",
    threadId: found.threadId ?? "",
    meetingStart: found.meetingStart ?? "",
    meetingEnd: found.meetingEnd ?? "",
    meetingLocation: found.meetingLocation ?? "",
    meetingRecurrence: found.meetingRecurrence ?? "",
    body: lines.slice(bodyStart).join("\n").trim(),
    meetingTimezone: found.meetingTimezone ?? ""
  };
}

// --- Nettoyage du body (patterns safe identifies) ------------------------

// (pattern, flags) — DOTALL uniquement pour les blocs "de X jusqu'a la fin/section
// suivante", jamais pour les lignes de signature (sinon ca bouffe tout le reste).
const RE_MAPS_LINK = /\[https:\/\/www\.google\.com\/maps[^\]]*\]/g;
const RE_EXTERNAL_BANNER = /External email:[\s\S]*?attachments\.\s*/g;
const RE_TEAMS_BOILERPLATE = /(Besoin d['’]aide\s*\?[\s\S]*|Need help\s*\?[\s\S]*)/g;
const RE_DASH_SEPARATOR = /-{10,}/g;
const RE_UNDERSCORE_SEPARATOR = /_{10,}/g;
const RE_STAR_SEPARATOR = /\*{10,}/g;
const RE_PHONE_LINE = /^phone:.*$/gm;
const RE_MOBILE_LINE = /^mobile:.*$/gm;
const RE_REPLY_URL_LINE = /^www\.reply\.\w+.*$/gm;
const RE_WEMANITY_LINE = /^Wemanity Reply.*$/gm;
const RE_PARAMETRI_BLOCK = /# Parametri\n[\s\S]*?(?=\n#|$)/g;

const CLEAN_PATTERNS: RegExp[] = [
  RE_MAPS_LINK,
  RE_EXTERNAL_BANNER,
  RE_TEAMS_BOILERPLATE,
  RE_DASH_SEPARATOR,
  RE_UNDERSCORE_SEPARATOR,
  RE_STAR_SEPARATOR,
  RE_PHONE_LINE,
  RE_MOBILE_LINE,
  RE_REPLY_URL_LINE,
  RE_WEMANITY_LINE,
  RE_PARAMETRI_BLOCK,
];

function cleanBody(text: string, keepTeamsBlock = false): string {
  let t = text;
  for (const pattern of CLEAN_PATTERNS) {
    if (keepTeamsBlock && pattern === RE_TEAMS_BOILERPLATE) continue;
    t = t.replace(pattern, "");
  }
  return t.replace(/\n\s*\n+/g, "\n\n").trim();
}

// --- Notion ---------------------------------------------------------------

function chunkRichText(text: string): Array<{ text: { content: string } }> {
  if (!text) return [];

  const chunks: Array<{ text: { content: string } }> = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_CHUNK) {
    if (chunks.length >= RICH_TEXT_MAX_CHUNKS) {
      chunks[RICH_TEXT_MAX_CHUNKS - 1] = {
        text: { content: chunks[RICH_TEXT_MAX_CHUNKS - 1].text.content.slice(0, 1900) + "\n\n[...tronque]" },
      };
      break;
    }
    chunks.push({ text: { content: text.slice(i, i + RICH_TEXT_CHUNK) } });
  }
  return chunks;
}

async function notion<T>(path: string, init: RequestInit): Promise<T> {
  const resp = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!resp.ok) {
    throw new Error(`Notion API ${resp.status} : ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

/** Filet de securite sur la fenetre entre creation Notion et archivage du fichier. */
async function alreadyInNotion(messageId: string): Promise<boolean> {
  if (!messageId) return false;

  const data = await notion<{ results: unknown[] }>(`/databases/${NOTION_DATABASE_ID}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: { property: "Message ID", rich_text: { equals: messageId } },
      page_size: 1,
    }),
  });
  return data.results.length > 0;
}

/** Offset (en minutes) de la zone tz au moment dateUtc. */
function offsetFor(dateUtc: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(dateUtc).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUtc - dateUtc.getTime()) / 60000;
}

/** "2026-09-07T12:00:00.0000000" + "Europe/Paris" -> "2026-09-07T12:00:00+02:00" */
function toIsoWithOffset(naive: string, tz: string): string {
  if (!naive) return "";
  const clean = naive.replace(/\.\d+$/, "");
  const zone = tz || "Europe/Paris";
  const guess = new Date(clean + "Z");
  // deuxieme passe : corrige le cas d'un basculement heure d'ete/hiver
  const off = offsetFor(new Date(guess.getTime() - offsetFor(guess, zone) * 60000), zone);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${clean}${sign}${hh}:${mm}`;
}

async function createNotionPage(parsed: ParsedEmail): Promise<void> {
  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: parsed.subject.slice(0, 2000) } }] },
    From: { rich_text: chunkRichText(parsed.from) },
    Body: { rich_text: chunkRichText(cleanBody(parsed.body, Boolean(parsed.meetingStart))) },
    Received: { date: { start: parsed.received } },
    "Message ID": { rich_text: chunkRichText(parsed.messageId) },
    "Thread ID": { rich_text: chunkRichText(parsed.threadId) },
    Source: { select: { name: "Reply" } },
    Status: { select: { name: "To process" } },
    ...(parsed.meetingStart
      ? {
        "Meeting start": { date: { start: toIsoWithOffset(parsed.meetingStart, parsed.meetingTimezone) } },
      }
      : {}),
    ...(parsed.meetingEnd
      ? { "Meeting end": { date: { start: toIsoWithOffset(parsed.meetingEnd, parsed.meetingTimezone) } }, }
      : {}),
    "Meeting location": { rich_text: chunkRichText(parsed.meetingLocation) },
    "Meeting recurrence": { rich_text: chunkRichText(parsed.meetingRecurrence) },
  };

  await notion("/pages", {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: NOTION_DATABASE_ID }, properties }),
  });
}

// --- Lecture resiliente (OneDrive Files On-Demand) -------------------------

// Delais entre tentatives. OneDrive peut renvoyer EAGAIN / "Unknown system
// error -11" sur un placeholder pas encore hydrate ou en cours d'ecriture ;
// un retry suffit generalement, d'ou l'etalement des delais.
const READ_RETRY_DELAYS_MS = [2000, 5000, 15000];

function isTransientReadError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  const message = (err as Error).message ?? "";
  return code === "EAGAIN" || code === "EBUSY" || code === "ENOENT" || message.includes("Unknown system error -11");
}

async function readFileWithRetry(filePath: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if (!isTransientReadError(err) || attempt >= READ_RETRY_DELAYS_MS.length) {
        throw err;
      }

      const delay = READ_RETRY_DELAYS_MS[attempt];
      const reason = (err as NodeJS.ErrnoException).code ?? "Unknown system error -11";
      console.log(`  retry ${attempt + 1}/${READ_RETRY_DELAYS_MS.length} apres ${reason} (attente ${delay / 1000}s)`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// --- Main -----------------------------------------------------------------

async function main(): Promise<void> {
  if (!NOTION_TOKEN) {
    console.error("NOTION_TOKEN manquant (export NOTION_TOKEN=secret_xxx)");
    process.exit(1);
  }

  try {
    await fs.access(INBOUND_DIR);
  } catch {
    console.error(`Dossier inbound introuvable : ${INBOUND_DIR}`);
    process.exit(1);
  }

  await fs.mkdir(ARCHIVE_DIR, { recursive: true });

  const entries = await fs.readdir(INBOUND_DIR, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();

  if (files.length === 0) {
    console.log("Aucun fichier a traiter.");
    return;
  }

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const fileName of files) {
    console.log(`- ${fileName}`);
    const filePath = path.join(INBOUND_DIR, fileName);

    try {
      const raw = await readFileWithRetry(filePath);
      const stat = await fs.stat(filePath);
      const stem = path.basename(fileName, path.extname(fileName));

      const parsed = parseEmailFile(raw, stem, stat.mtime);

      if (await alreadyInNotion(parsed.messageId)) {
        // Deja en base : le run precedent a plante entre l'ecriture et l'archivage.
        await fs.rename(filePath, path.join(ARCHIVE_DIR, fileName));
        console.log("  deja en base -> archive sans reecriture");
        skipped++;
        continue;
      }

      await createNotionPage(parsed);
      await fs.rename(filePath, path.join(ARCHIVE_DIR, fileName));

      console.log("  ok -> Notion + archive");
      imported++;
    } catch (err) {
      console.log(`  echec (${(err as Error).message}) -> laisse dans inbound pour retry`);
      failed++;
    }
  }

  console.log(`\nTermine. ${imported} importe(s), ${skipped} deja en base, ${failed} echec(s).`);
}

main();
