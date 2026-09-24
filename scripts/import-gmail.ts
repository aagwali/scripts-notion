#!/usr/bin/env -S npx tsx
/**
 * Ingestion des emails Gmail vers la base Notion "Raw inputs".
 *
 * Gmail reste la source de verite. Ce script en produit une projection
 * allegee dans Notion, destinee a la tache planifiee A. Il ne fait que du
 * factuel : extraction d'en-tetes, aplatissement du corps, nettoyage
 * mecanique. Aucune classification, aucun resume.
 *
 * Cycle d'idempotence :
 *   Gmail (label "Importe")  ->  Notion (Status "To process")
 *                            ->  A : Gmail "Traite" + Notion "Processed"
 * Le label porte la deduplication cote source ; un controle d'existence par
 * Message ID cote Notion couvre la fenetre entre les deux ecritures.
 *
 * Usage :
 *   npm install tsx dotenv
 *   npx tsx scripts/google-auth.ts        (une seule fois)
 *   npx tsx scripts/import-gmail.ts
 *
 * Variables d'environnement (.env) :
 *   NOTION_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *
 * Node >= 18 requis (fetch natif).
 */

import "dotenv/config";
import { instance } from "../config/index.ts";

// --- Config -----------------------------------------------------------

const NOTION_DATABASE_ID = instance.notion.databases.rawInputs.database_id;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2022-06-28";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Label pose apres insertion reussie dans Notion. Cle de deduplication. */
const IMPORT_LABEL = "Importé";
/** Label pose par la tache A. Exclu de l'ingestion. */
const PROCESSED_LABEL = "Traité";

/**
 * Perimetre d'un run, reprenant les deux lots du §1 de la tache A.
 * Le bornage a 2 jours vaut aussi pour le premier run : au-dela, un mail non
 * importe releve de l'incident, pas du fonctionnement nominal.
 */
const GMAIL_QUERY =
  `(in:inbox OR (is:unread -in:inbox)) ` +
  `-label:"${IMPORT_LABEL}" -label:"${PROCESSED_LABEL}" newer_than:2d`;

const MAX_MESSAGES_PER_RUN = 100;

const RICH_TEXT_CHUNK = 2000; // limite Notion par objet rich_text
const RICH_TEXT_MAX_CHUNKS = 100; // limite Notion par propriete (~200 000 car.)

// --- Auth Google --------------------------------------------------------

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

// --- Types Gmail --------------------------------------------------------

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

interface GmailLabel {
  id: string;
  name: string;
}

// --- Labels -------------------------------------------------------------

let labelsById: Map<string, string> = new Map();

async function loadLabels(): Promise<void> {
  const data = await gmail<{ labels?: GmailLabel[] }>("/labels");
  labelsById = new Map((data.labels ?? []).map((l) => [l.id, l.name]));
}

/** Retourne l'id du label d'import, en le creant s'il n'existe pas. */
async function ensureImportLabel(): Promise<string> {
  for (const [id, name] of labelsById) {
    if (name === IMPORT_LABEL) return id;
  }

  console.log(`Creation du label Gmail "${IMPORT_LABEL}"`);
  const created = await gmail<GmailLabel>("/labels", {
    method: "POST",
    body: JSON.stringify({
      name: IMPORT_LABEL,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  });

  labelsById.set(created.id, created.name);
  return created.id;
}

/**
 * Traduit les labelIds en noms lisibles.
 * Les virgules sont interdites dans une option multi-select Notion.
 */
function labelNames(labelIds: string[] | undefined): string[] {
  return (labelIds ?? [])
    .map((id) => labelsById.get(id) ?? id)
    .map((name) => name.replace(/,/g, " "))
    .filter(Boolean);
}

// --- Extraction du message ----------------------------------------------

function header(msg: GmailMessage, name: string): string {
  const headers = msg.payload?.headers ?? [];
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found?.value?.trim() ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, " ");
}

/** Parcourt l'arbre MIME, en privilegiant text/plain sur text/html. */
function extractBody(part: GmailPart | undefined): string {
  if (!part) return "";

  const plain: string[] = [];
  const html: string[] = [];

  const walk = (node: GmailPart): void => {
    // Les pieces jointes portent un filename : jamais de corps a en tirer.
    if (node.filename) return;

    if (node.body?.data) {
      if (node.mimeType === "text/plain") plain.push(decodeBase64Url(node.body.data));
      else if (node.mimeType === "text/html") html.push(decodeBase64Url(node.body.data));
    }
    for (const child of node.parts ?? []) walk(child);
  };

  walk(part);

  if (plain.length) return plain.join("\n");
  if (html.length) return htmlToText(html.join("\n"));
  return "";
}

/**
 * En-tete List-Unsubscribe (RFC 2369), source du bouton natif Gmail.
 * Une ou plusieurs URI entre chevrons : https prioritaire, mailto a defaut.
 */
function extractUnsubscribe(msg: GmailMessage): string {
  const raw = header(msg, "List-Unsubscribe");
  if (!raw) return "";

  const uris = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  return uris.find((u) => u.toLowerCase().startsWith("http")) ?? uris[0] ?? "";
}

// --- Nettoyage du corps -------------------------------------------------

// Patterns generiques. Volontairement conservateurs : mieux vaut laisser du
// bruit que rogner du contenu utile a la tache A.
// Ne jamais utiliser DOTALL sur une ligne de signature : ca avale la suite.
const RE_QUOTED_LINES = /^>.*$/gm; // citations de reponse
const RE_ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u00AD]/g; // caracteres invisibles de tracking
const RE_DASH_SEPARATOR = /-{10,}/g;
const RE_UNDERSCORE_SEPARATOR = /_{10,}/g;
const RE_STAR_SEPARATOR = /\*{10,}/g;
const RE_EQUAL_SEPARATOR = /={10,}/g;
const RE_TRACKING_PIXEL = /\[image:[^\]]*\]/gi;
const RE_LONE_URL_LINE = /^\s*<?https?:\/\/\S{120,}>?\s*$/gm; // URL de tracking tres longue
const RE_UNSUB_FOOTER =
  /^.{0,120}(se\s+d[ée]sabonner|d[ée]sabonnement|se\s+d[ée]sinscrire|unsubscribe|g[ée]rer\s+(mes|mon)\s+(pr[ée]f[ée]rences?|abonnements?)|ne\s+plus\s+recevoir).{0,120}$/gim;
const RE_VIEW_IN_BROWSER =
  /^.{0,120}(afficher\s+(ce\s+)?(mail|message|email)\s+dans\s+(le\s+)?navigateur|view\s+(this\s+)?(email|message)\s+in\s+(your\s+)?browser|voir\s+la\s+version\s+en\s+ligne).{0,120}$/gim;

const CLEAN_PATTERNS: RegExp[] = [
  RE_ZERO_WIDTH,
  RE_QUOTED_LINES,
  RE_TRACKING_PIXEL,
  RE_UNSUB_FOOTER,
  RE_VIEW_IN_BROWSER,
  RE_LONE_URL_LINE,
  RE_DASH_SEPARATOR,
  RE_UNDERSCORE_SEPARATOR,
  RE_STAR_SEPARATOR,
  RE_EQUAL_SEPARATOR,
];

function cleanBody(text: string): string {
  let t = text.replace(/\r\n/g, "\n");
  for (const pattern of CLEAN_PATTERNS) {
    t = t.replace(pattern, "");
  }
  t = t.replace(/[ \t]+$/gm, ""); // espaces en fin de ligne
  t = t.replace(/\n\s*\n+/g, "\n\n"); // lignes vides multiples -> une seule
  return t.trim();
}

// --- Notion -------------------------------------------------------------

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

/** Filet de securite sur la fenetre entre creation Notion et pose du label. */
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

interface NotionRow {
  subject: string;
  from: string;
  body: string;
  received: string;
  messageId: string;
  threadId: string;
  gmailUrl: string;
  gmailId: string;
  labels: string[];
  unsubscribe: string;
}

async function createNotionPage(row: NotionRow): Promise<void> {
  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: row.subject.slice(0, 2000) } }] },
    From: { rich_text: chunkRichText(row.from) },
    Body: { rich_text: chunkRichText(row.body) },
    Received: { date: { start: row.received } },
    "Message ID": { rich_text: chunkRichText(row.messageId) },
    "Thread ID": { rich_text: chunkRichText(row.threadId) },
    "Gmail message ID": { rich_text: chunkRichText(row.gmailId) },
    Labels: { multi_select: row.labels.map((name) => ({ name })) },
    Source: { select: { name: "Perso" } },
    Channel: { select: { name: "Email" } },
    Status: { select: { name: "To process" } },
  };

  // Notion rejette une propriete url vide : on l'omet plutot que d'envoyer "".
  if (row.gmailUrl) properties["Gmail URL"] = { url: row.gmailUrl };
  if (row.unsubscribe) properties["Unsubscribe URL"] = { url: row.unsubscribe };

  await notion("/pages", {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: NOTION_DATABASE_ID }, properties }),
  });
}

// --- Main ---------------------------------------------------------------

async function main(): Promise<void> {
  const missing = [
    ["NOTION_TOKEN", NOTION_TOKEN],
    ["GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID],
    ["GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET],
    ["GOOGLE_REFRESH_TOKEN", GOOGLE_REFRESH_TOKEN],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    console.error(`Variables d'environnement manquantes : ${missing.join(", ")}`);
    console.error("Pour GOOGLE_REFRESH_TOKEN, lancez d'abord : npx tsx scripts/google-auth.ts");
    process.exit(1);
  }

  await loadLabels();
  const importLabelId = await ensureImportLabel();

  const list = await gmail<{ messages?: Array<{ id: string }> }>(
    `/messages?q=${encodeURIComponent(GMAIL_QUERY)}&maxResults=${MAX_MESSAGES_PER_RUN}`,
  );
  const ids = (list.messages ?? []).map((m) => m.id);

  if (ids.length === 0) {
    console.log("Aucun message a traiter.");
    return;
  }

  console.log(`${ids.length} message(s) a traiter.`);
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      const msg = await gmail<GmailMessage>(`/messages/${id}?format=full`);

      const messageId = header(msg, "Message-ID") || header(msg, "Message-Id");
      const subject = header(msg, "Subject") || "(sans objet)";

      console.log(`- ${subject.slice(0, 70)}`);

      if (await alreadyInNotion(messageId)) {
        // Deja en base : le run precedent a plante entre l'ecriture et le label.
        await gmail(`/messages/${id}/modify`, {
          method: "POST",
          body: JSON.stringify({ addLabelIds: [importLabelId] }),
        });
        console.log("  deja en base -> label rattrape");
        skipped++;
        continue;
      }

      const receivedRaw = header(msg, "Date");
      const parsedDate = new Date(receivedRaw);
      const received = isNaN(parsedDate.getTime())
        ? new Date(Number(msg.internalDate ?? Date.now())).toISOString()
        : parsedDate.toISOString();

      await createNotionPage({
        subject,
        from: header(msg, "From"),
        body: cleanBody(extractBody(msg.payload)),
        received,
        messageId,
        threadId: msg.threadId,
        gmailId: id,
        gmailUrl: `https://mail.google.com/mail/u/0/#all/${msg.threadId}`,
        labels: labelNames(msg.labelIds),
        unsubscribe: extractUnsubscribe(msg),
      });

      // Toujours apres l'ecriture Notion : le label signifie "present en base".
      await gmail(`/messages/${id}/modify`, {
        method: "POST",
        body: JSON.stringify({ addLabelIds: [importLabelId] }),
      });

      console.log("  ok -> Notion + label Importe");
      imported++;
    } catch (err) {
      // Pas de label pose : le message repassera au run suivant.
      console.log(`  echec (${(err as Error).message}) -> retente au prochain run`);
      failed++;
    }
  }

  console.log(`\nTermine. ${imported} importe(s), ${skipped} deja en base, ${failed} echec(s).`);
}

main().catch((err) => {
  console.error(`Echec du run : ${(err as Error).message}`);
  process.exit(1);
});