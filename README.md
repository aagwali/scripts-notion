# scripts-notion

Scripts d'automatisation autour d'un meme espace Notion, partageant une
seule integration (`NOTION_TOKEN`) et un seul jeu de dependances.

**Ingestion d'emails.** Deux scripts alimentent la base "Raw emails" a
partir de deux sources differentes : Gmail (API) et Outlook Pro (export
local via Power Automate / OneDrive). Chaque page Notion cree porte
`Status: "To process"`, consomme ensuite par une tache aval (non incluse
ici).

**Entretien des bases.** Trois autres scripts, sans rapport avec les
emails, sortent les phases terminees de la base "Phases", remettent a
zero chaque nuit la base "Recurring events", et mettent a la corbeille
chaque dimanche les journaux de run et digests relus de la base "Docs".

**Projection vers Google Calendar.** Un script reporte les dates
`Deadline` et `Reminder` de la base "Tasks" dans deux calendriers Google
dedies, et retire de l'agenda ce qui a disparu de Notion.

**Planning d'Aline.** Un dernier script projette vers Google Calendar les
jours travailles de la base "Planning Aline", elle-meme alimentee par une
tache Claude qui lit la photo d'un tableau blanc.

## Les sept flux

Chaque flux a sa page : fonctionnement, choix de conception, lancement,
planification, logs et pannes propres.

| Flux | Ce qu'il fait | Declencheur |
|---|---|---|
| [Gmail -> Notion](docs/gmail.md) | ingestion des emails Gmail | GitHub Actions, quotidien |
| [Outlook -> Notion](docs/outlook.md) | ingestion des emails Outlook Pro | LaunchAgent local, quotidien |
| [Archivage des phases](docs/archive-phases.md) | sort les phases terminees de "Phases" | GitHub Actions, hebdomadaire |
| [Reset des evenements recurrents](docs/recurring-events.md) | reamorce "Recurring events" chaque nuit | GitHub Actions, quotidien |
| [Tasks -> Google Calendar](docs/tasks-calendar.md) | projette `Deadline` / `Reminder` | GitHub Actions, quotidien |
| [Planning d'Aline](docs/planning-aline.md) | projette les jours travailles | a la demande |
| [Nettoyage de la base Docs](docs/clean-docs.md) | corbeille les logs et digests relus | GitHub Actions, hebdomadaire |

Hors flux : [sortir l'app OAuth du mode Testing](docs/oauth-production.md).

## Arborescence

```
scripts/
  import-gmail.ts                 # Gmail -> Notion
  import-outlook.ts               # Outlook -> Notion
  archive-phases.ts               # entretien base Phases
  reset-recurring-events.ts       # reset base Recurring events
  reset-recurring-events.test.ts  # tests de la logique de serie, sans appel Notion
  clean-docs.ts                   # entretien base Docs
  sync-tasks-calendar.ts          # Tasks -> Google Calendar
  sync-planning-aline.ts          # Planning Aline -> Google Calendar
  google-auth.ts                  # utilitaire : genere GOOGLE_REFRESH_TOKEN, a lancer une fois
docs/                             # une page par flux, plus le runbook OAuth
.claude/skills/
  planning-aline/SKILL.md         # la tache Claude qui lit la photo du tableau
.github/workflows/                # un workflow par flux, sauf import-outlook (local)
```

## Planification

Tout tourne de nuit, dans cet ordre (heures de Paris) :

| Heure | Script | Declencheur | Cron |
|---|---|---|---|
| 22h | `import-gmail` | GitHub Actions | `0 20 * * *` UTC |
| 23h | `import-outlook` | LaunchAgent local | `Hour 23` (heure locale) |
| minuit | `reset-recurring-events` | GitHub Actions | `0 22` + `0 23 * * *` UTC |
| 2h | `sync-tasks-calendar` | GitHub Actions | `0 0 * * *` UTC |
| dimanche 5h | `clean-docs` | GitHub Actions | `0 3 * * 0` UTC |
| lundi 4h | `archive-phases` | GitHub Actions | `0 2 * * 1` UTC |

Trois reserves valent pour **tous** les workflows GitHub, et ne sont pas
repetees dans les pages de flux :

- **Les heures sont ecrites en UTC et ne suivent pas le changement
  d'heure.** Celles du tableau valent pour l'ete (CEST), tout glisse d'une
  heure en hiver, a corriger a la main dans le cron si besoin. Seul
  [`reset-recurring-events`](docs/recurring-events.md) y echappe, avec ses
  deux crons encadrant minuit.
- **Un run planifie peut etre retarde** de plusieurs minutes a plusieurs
  heures selon la charge de l'infra GitHub. L'etalement ecrit dans les
  crons n'est pas celui qui est obtenu — l'ordre du tableau a surtout une
  valeur de lisibilite, aucun script ne depend de l'heure de passage d'un
  autre.
- **Le cron ne se declenche que sur la branche par defaut** (`main`) —
  pusher ailleurs ne suffit pas.

[`sync-planning-aline`](docs/planning-aline.md) echappe au tableau : aucun
cron, il est declenche a la main (ou par la skill) quand une nouvelle photo
du tableau blanc arrive.

Les tests (`npm test`) ne couvrent que `reset-recurring-events` : c'est le
seul script dont le comportement depend d'un arbitrage de dates invisible
a la relecture.

Tous les scripts lisent `.env` **relativement au repertoire courant** :
les lancer depuis la racine du repo, jamais depuis `scripts/`. Les
raccourcis `npm run` (`import:gmail`, `import:outlook`, `archive-phases`,
`clean-docs`, `google-auth`, `sync-tasks-calendar`, `sync-planning-aline`)
s'en chargent.

## Prerequis communs

- Node >= 18 (fetch natif)
- `npm install`
- Une integration Notion partagee avec les bases utilisees. Chaque page de
  flux nomme les siennes ; l'ensemble couvre "Raw emails"
  (`ba36c9eb-2587-49e0-abd3-0d47276511c0`, code en dur dans les deux
  scripts d'ingestion), "Phases", "Phases archivees", "Tasks", "Docs",
  "Projects", "Sponsors", "Recurring events" et "Planning Aline".
- Un client OAuth Google, decrit ci-dessous.

### Mise en place OAuth Google

Un **seul** client OAuth couvre Gmail et Calendar : `google-auth.ts`
demande les deux scopes (`gmail.modify` + `calendar.events`) en une fois,
et le refresh token obtenu sert a tous les flux Google du repo. Le digest
de `clean-docs` part avec le meme `gmail.modify`, qui couvre
`messages.send`.

1. Dans [console.cloud.google.com](https://console.cloud.google.com) :
   activer l'API Gmail et l'API Google Calendar, creer un client OAuth de
   type **Desktop app** (obligatoire pour le flux loopback), ajouter votre
   compte comme *Test user* si l'app est en mode Testing.
2. Renseigner `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` dans `.env`.
3. Lancer une seule fois :
   ```
   npx tsx scripts/google-auth.ts
   ```
   Ouvre le navigateur, demande le consentement, ecrit
   `GOOGLE_REFRESH_TOKEN` dans `.env` automatiquement.
   > En mode Testing, ce refresh token expire au bout de **7 jours**.
   > Pour en sortir une bonne fois : [`docs/oauth-production.md`](docs/oauth-production.md).
4. Repousser le secret si les scripts sont planifies :
   ```
   gh secret set GOOGLE_REFRESH_TOKEN --repo aagwali/scripts-notion --body "..."
   ```

Un refresh token porte les scopes accordes **au moment de son emission** :
apres tout ajout de scope, il faut relancer `google-auth.ts` et repousser
le secret.

## Variables d'environnement

Fichier `.env` local (jamais commite, voir `.gitignore`) :

| Variable | Utilise par | Description |
|---|---|---|
| `NOTION_TOKEN` | tous | Token d'integration Notion (`secret_xxx` ou `ntn_xxx`) |
| `GOOGLE_CLIENT_ID` | Gmail, Calendar, Docs | Client OAuth Google (type "Desktop app") |
| `GOOGLE_CLIENT_SECRET` | Gmail, Calendar, Docs | Secret du client OAuth |
| `GOOGLE_REFRESH_TOKEN` | Gmail, Calendar, Docs | Genere une fois via `scripts/google-auth.ts`, porte les deux scopes |

Les memes quatre variables sont posees en secrets du repo
(`Settings > Secrets and variables > Actions`) pour les workflows.

Les ids de bases Notion et de calendriers Google sont codes en dur dans les
scripts — ce ne sont pas des secrets.

## Consulter les logs

Chaque page de flux indique ou lire sa trace. Deux points valent pour tous
les workflows GitHub :

- Interface web : [Actions du repo](https://github.com/aagwali/scripts-notion/actions)
  — ouvrir le run, chaque step est depliable avec ses logs complets.
- En CLI :
  ```
  gh run list --repo aagwali/scripts-notion --workflow "<nom du workflow>" --limit 5
  gh run view <run-id> --repo aagwali/scripts-notion --log
  ```

Les runs GitHub Actions sont conserves **90 jours**. Pour un lot important
(premiere execution, reprise apres incident), lancer plutot le script en
local et garder la sortie :

```
npx tsx scripts/archive-phases.ts | tee logs/archive-phases-$(date +%F).log
```

## Depannage

Pannes transverses. Les pannes propres a un flux sont sur sa page :
[Outlook](docs/outlook.md#depannage) (launchd, plist),
[archivage](docs/archive-phases.md#depannage) (proprietes, `INCOMPLET`),
[Tasks Calendar](docs/tasks-calendar.md#depannage) (scope Calendar).

- **`Variables d'environnement manquantes`** : verifier `.env` —
  attention au format, `client id : xxx` n'est PAS une syntaxe valide, il
  faut `GOOGLE_CLIENT_ID=xxx`.
- **Rafraichissement Google refuse** : si l'app OAuth est en mode
  Testing, le refresh token expire au bout de 7 jours — relancer
  `npx tsx scripts/google-auth.ts`. Pour en sortir une bonne fois, voir
  [`docs/oauth-production.md`](docs/oauth-production.md).
- **`Notion API 404` sur une base** : l'integration n'a pas acces a la
  base. Un 404 Notion signifie "invisible pour ce token", pas
  "inexistant" — partager la base depuis son menu `...` > `Connexions`.
