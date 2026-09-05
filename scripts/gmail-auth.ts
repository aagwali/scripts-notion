#!/usr/bin/env -S npx tsx
/**
 * Autorisation OAuth Gmail — a lancer UNE SEULE FOIS.
 *
 * Flux "loopback" (RFC 8252), le seul supporte par Google pour les scopes
 * Gmail : un serveur HTTP local ephemere recoit le code d'autorisation, qui
 * est ensuite echange contre un refresh token, ecrit dans .env.
 *
 * Le flux "device code" n'est PAS utilisable ici : Google le refuse pour les
 * scopes Gmail ("Invalid device flow scope").
 *
 * Prerequis (console.cloud.google.com) :
 *   - Gmail API activee
 *   - Client OAuth de type "Desktop app" (obligatoire : c'est le seul type qui
 *     accepte un redirect_uri loopback sur port dynamique)
 *   - En mode Testing : votre compte ajoute comme "Test user"
 *
 * Usage :
 *   export GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com"
 *   export GOOGLE_CLIENT_SECRET="xxx"
 *   npx tsx gmail-auth.ts
 *
 * Node >= 18 requis.
 */

import "dotenv/config";
import * as http from "http";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import { AddressInfo } from "net";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// gmail.modify = lecture + pose/retrait de labels + corbeille.
// N'autorise PAS la suppression definitive.
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ENV_FILE = ".env";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    }).unref();
  } catch {
    // pas grave : l'URL est affichee dans la console de toute facon
  }
}

/**
 * Demarre un serveur local ephemere et attend le retour d'OAuth.
 *
 * Le redirect_uri est fige des l'ecoute et conserve dans une variable de
 * portee externe : il doit etre STRICTEMENT identique dans la requete
 * d'autorisation et dans l'echange du code, sinon Google rejette l'echange.
 * (Ne jamais le reconstruire depuis server.address() apres close() :
 * address() renvoie null des que le serveur n'ecoute plus.)
 */
function waitForCode(): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    let settled = false;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri || "http://127.0.0.1");

      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        code
          ? "<h2>Autorisation accordee.</h2><p>Vous pouvez fermer cet onglet et revenir au terminal.</p>"
          : `<h2>Echec de l'autorisation</h2><p>${error ?? "code absent"}</p>`,
        () => {
          // On ferme seulement une fois la reponse ecrite, et on resout avec
          // le redirectUri fige plus haut.
          server.close();
          if (settled) return;
          settled = true;
          if (code) resolve({ code, redirectUri });
          else reject(new Error(error ?? "code absent dans la redirection"));
        },
      );
    });

    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      redirectUri = `http://127.0.0.1:${port}`;

      const authUrl =
        `${AUTH_URL}?` +
        new URLSearchParams({
          client_id: CLIENT_ID!,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPE,
          access_type: "offline", // indispensable pour obtenir un refresh token
          prompt: "consent", // force la re-emission du refresh token
        }).toString();

      console.log(`Redirect URI utilise : ${redirectUri}`);
      console.log("Ouverture du navigateur pour autorisation...");
      console.log(`Si rien ne s'ouvre, copiez cette URL :\n\n${authUrl}\n`);
      console.log(
        "L'ecran \"Google n'a pas valide cette application\" est normal en mode Testing :\n" +
        "  Parametres avances > Continuer vers <nom de l'app>\n",
      );
      openBrowser(authUrl);
    });
  });
}

async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });

  const raw = await resp.text();

  let data: { refresh_token?: string; error?: string; error_description?: string } = {};
  try {
    data = JSON.parse(raw);
  } catch {
    // Google renvoie parfois du HTML/texte : on le remonte tel quel.
  }

  if (!resp.ok) {
    throw new Error(
      `Echange du code refuse (${resp.status}) : ${data.error_description ?? data.error ?? raw.slice(0, 300)}`,
    );
  }
  if (!data.refresh_token) {
    throw new Error(
      "Aucun refresh_token retourne. Revoquez l'acces de l'app sur " +
      "https://myaccount.google.com/permissions puis relancez.",
    );
  }
  return data.refresh_token;
}

/** Ecrit ou remplace GOOGLE_REFRESH_TOKEN dans .env, sans toucher au reste. */
async function writeEnv(refreshToken: string): Promise<void> {
  let content = "";
  try {
    content = await fs.readFile(ENV_FILE, "utf-8");
  } catch {
    // .env absent, on le cree
  }

  const line = `GOOGLE_REFRESH_TOKEN="${refreshToken}"`;
  const re = /^GOOGLE_REFRESH_TOKEN=.*$/m;

  content = re.test(content)
    ? content.replace(re, line)
    : (content.trimEnd() + "\n" + line + "\n").trimStart();

  await fs.writeFile(ENV_FILE, content, "utf-8");
}

async function main(): Promise<void> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET requis.");
    process.exit(1);
  }

  const { code, redirectUri } = await waitForCode();
  const refreshToken = await exchangeCode(code, redirectUri);
  await writeEnv(refreshToken);

  console.log(`\nRefresh token ecrit dans ${ENV_FILE}.`);
  console.log("Verifiez que .env est bien dans votre .gitignore.");
}

main().catch((err) => {
  console.error(`Echec : ${(err as Error).message}`);
  process.exit(1);
});