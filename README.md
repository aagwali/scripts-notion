# email-to-notion

Deux scripts qui alimentent la meme base Notion ("Raw emails") a partir de
deux sources differentes : Gmail (API) et Outlook Pro (export local via
Power Automate / OneDrive). Chaque page Notion cree porte `Status: "To
process"`, consomme ensuite par une tache aval (non incluse ici).

## Prerequis communs

- Node >= 18 (fetch natif)
- `npm install`
- Une integration Notion avec acces a la base "Raw emails"
  (`NOTION_DATABASE_ID` est code en dur dans les deux scripts : `ba36c9eb-2587-49e0-abd3-0d47276511c0`)

## Variables d'environnement

Fichier `.env` local (jamais commite, voir `.gitignore`) :

| Variable | Utilise par | Description |
|---|---|---|
| `NOTION_TOKEN` | les deux | Token d'integration Notion (`secret_xxx` ou `ntn_xxx`) |
| `GOOGLE_CLIENT_ID` | Gmail | Client OAuth Google (type "Desktop app") |
| `GOOGLE_CLIENT_SECRET` | Gmail | Secret du client OAuth |
| `GOOGLE_REFRESH_TOKEN` | Gmail | Genere une fois via `gmail-auth.ts` |

---

## 1. Gmail -> Notion

Fichier : [`email-to-notion-input-gmail.ts`](email-to-notion-input-gmail.ts)

### Fonctionnement

- Requete Gmail : messages de la boite de reception (ou non lus hors boite),
  de moins de 2 jours, sans le label `Importe` ni `Traite`.
- Pour chaque message : extraction des en-tetes, aplatissement du corps
  (text/plain prioritaire sur text/html), nettoyage mecanique (citations,
  pixels de tracking, footers de desabonnement...), creation de la page
  Notion, puis pose du label Gmail `Importe`.
- Idempotence : un message deja present en Notion (verifie par `Message
  ID`) est simplement relabellise sans recreer de page — couvre le cas d'un
  run precedent interrompu entre l'ecriture Notion et la pose du label.
- 100 messages max par run.

### Mise en place initiale

1. Dans [console.cloud.google.com](https://console.cloud.google.com) :
   activer l'API Gmail, creer un client OAuth de type **Desktop app**
   (obligatoire pour le flux loopback), ajouter votre compte comme *Test
   user* si l'app est en mode Testing.
2. Renseigner `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` dans `.env`.
3. Lancer une seule fois :
   ```
   npx tsx gmail-auth.ts
   ```
   Ouvre le navigateur, demande le consentement, ecrit
   `GOOGLE_REFRESH_TOKEN` dans `.env` automatiquement.
   > En mode Testing, ce refresh token expire au bout de 7 jours — relancer
   > `gmail-auth.ts` si le script commence a echouer avec une erreur de
   > rafraichissement.
4. Lancer manuellement pour verifier :
   ```
   npx tsx email-to-notion-input-gmail.ts
   ```

### Planification : GitHub Actions

Workflow : [`.github/workflows/email-to-notion-gmail.yml`](.github/workflows/email-to-notion-gmail.yml)

- Declenchement quotidien a `20:00` UTC (soit 22h heure de Paris en ete,
  21h en hiver). GitHub Actions ne connait que l'UTC : pas d'ajustement
  automatique au changement d'heure, a corriger manuellement dans le
  cron si besoin.
  > A noter : les runs planifies GitHub Actions peuvent etre retardes de
  > plusieurs heures en cas de forte charge sur l'infra GitHub — ce n'est
  > pas garanti a l'heure pile.
- Secrets requis sur le repo (`Settings > Secrets and variables >
  Actions`) : `NOTION_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REFRESH_TOKEN`.
  ```
  gh secret set NOTION_TOKEN --repo aagwali/email-to-notion --body "..."
  gh secret set GOOGLE_CLIENT_ID --repo aagwali/email-to-notion --body "..."
  gh secret set GOOGLE_CLIENT_SECRET --repo aagwali/email-to-notion --body "..."
  gh secret set GOOGLE_REFRESH_TOKEN --repo aagwali/email-to-notion --body "..."
  ```
- Le cron GitHub Actions ne se declenche que sur la **branche par
  defaut** (`main`) — pusher ailleurs ne suffit pas.
- Declenchement manuel pour tester :
  ```
  gh workflow run "Email to Notion (Gmail)" --repo aagwali/email-to-notion
  gh run list --repo aagwali/email-to-notion --limit 1
  ```

---

## 2. Outlook -> Notion

Fichier : [`email-to-notion-input-outlook.ts`](email-to-notion-input-outlook.ts)

### Fonctionnement

Outlook Pro n'expose rien via l'API (pas d'URL de message, pas de labels,
pas de `List-Unsubscribe`). Un flux Power Automate depose donc un fichier
texte par email dans un dossier OneDrive local :

```
/Users/a.agwali/Library/CloudStorage/OneDrive-Reply/emails/inbound/
```

En-tetes attendus en tete de fichier, suivis d'une ligne vide :
```
De: ...
Objet: ...
Reçu: ...
Message ID: @{triggerOutputs()?['body/internetMessageId']}
Thread ID: @{triggerOutputs()?['body/conversationId']}
```

Le script lit chaque fichier, cree la page Notion correspondante
(`Source: "Reply"`), puis deplace le fichier vers
`.../emails/archive/`. Idempotence assuree comme pour Gmail (controle par
`Message ID` avant creation).

### Lancement manuel

```
npx tsx email-to-notion-input-outlook.ts
```

### Planification : LaunchAgent local

Ce script depend d'un dossier local (OneDrive monte), donc pas de
GitHub Actions possible — il tourne directement sur la machine via
launchd.

Plist : `~/Library/LaunchAgents/com.agwali.email-to-notion-outlook.plist`
— declenche tous les jours a **3h30 heure locale**.

```
# recharger apres modification du plist
launchctl unload ~/Library/LaunchAgents/com.agwali.email-to-notion-outlook.plist
launchctl load ~/Library/LaunchAgents/com.agwali.email-to-notion-outlook.plist

# forcer un run manuel
launchctl start com.agwali.email-to-notion-outlook

# logs
cat logs/outlook.log
```

**A propos de la veille** : un ecran verrouille n'empeche pas le job de
se lancer (la session reste active). En revanche, fermer le capot met
*toute la machine* en veille — le job ne se declenche alors qu'au reveil
suivant, pas a 3h30 pile. Si le Mac reste ouvert et **branche sur
secteur**, `pmset` est configure ici pour ne jamais dormir automatiquement
sur secteur, donc le job tourne a l'heure, ecran eteint ou non.

Si ce compromis "best effort" ne convient pas, deux alternatives sans
rien reconstruire :
- **Reveil programme** : `sudo pmset repeat wakeorpoweron MTWRFSU
  03:25:00` (reveille la machine juste avant l'heure du job, meme capot
  ferme et sur secteur).
- **Bascule sur 17h** : changer `Hour`/`Minute` dans le plist puis
  recharger — a cette heure la machine est presque surement deja active.

---

## Consulter les logs d'execution

Au-dela du resultat visible dans la base Notion, chaque script a sa propre
trace technique.

### Gmail (GitHub Actions)

- Interface web : [Actions du repo](https://github.com/aagwali/email-to-notion/actions)
  — ouvrir le run du jour, chaque step est depliable avec ses logs complets.
- En CLI :
  ```
  gh run list --repo aagwali/email-to-notion --limit 5
  gh run view <run-id> --repo aagwali/email-to-notion --log
  ```
- Un seul run attendu chaque nuit, autour de `20:00` UTC — mais l'heure
  reelle de declenchement peut varier (voir remarque sur les delais plus
  haut).

### Outlook (LaunchAgent)

- Fichier de log (stdout + stderr combines) :
  ```
  cat logs/outlook.log
  ```
  Contient soit `Aucun fichier a traiter.`, soit le detail des imports
  (`- fichier.txt` / `ok -> Notion + archive`), soit un message d'echec.
- Code de sortie du dernier run (0 = OK) :
  ```
  launchctl list | grep email-to-notion
  ```
- Si `logs/outlook.log` est vide ou absent, c'est le signe que launchd n'a
  meme pas declenche le job (ex : machine en veille toute la nuit). Le
  detail se trouve alors dans les logs systeme :
  ```
  log show --predicate 'process == "launchd"' --last 12h | grep email-to-notion-outlook
  ```
  ou via Console.app en filtrant sur `email-to-notion-outlook`.

---

## Depannage

- **`Variables d'environnement manquantes`** (Gmail) : verifier `.env` —
  attention au format, `client id : xxx` n'est PAS une syntaxe valide, il
  faut `GOOGLE_CLIENT_ID=xxx`.
- **`command not found: npx` dans les logs du LaunchAgent** : launchd
  n'herite pas du PATH du shell interactif (nvm charge via `.zshrc` n'est
  pas source en mode non-interactif). Le plist source `nvm.sh`
  explicitement avant d'appeler `npx` — si `node`/`nvm` ont ete
  reinstalles ou deplaces, adapter la commande dans le plist.
- **Rafraichissement Google refuse** : si l'app OAuth est en mode
  Testing, le refresh token expire au bout de 7 jours — relancer
  `npx tsx gmail-auth.ts`.
- **Plist invalide (`plutil -lint` echoue)** : les caracteres `&`, `<`,
  `>` doivent etre echappes en XML (`&amp;`, `&lt;`, `&gt;`) dans les
  `ProgramArguments`.
