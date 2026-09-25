# scripts-notion

Scripts d'automatisation autour d'un meme espace Notion, partageant une
seule integration (`NOTION_TOKEN`) et un seul jeu de dependances.

**Ingestion.** Un script alimente la base "Raw inputs" depuis Gmail
(API). Chaque page Notion cree porte `Status: "To process"`, consomme
ensuite par une tache aval (non incluse ici). La base recoit aussi des
captures ecrites hors depot.

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

## Les six flux

Chaque flux a sa page : fonctionnement, choix de conception, lancement,
planification, logs et pannes propres.

| Flux | Ce qu'il fait | Declencheur |
|---|---|---|
| [Gmail -> Notion](docs/scripts/import-gmail.md) | ingestion des emails Gmail | GitHub Actions, quotidien |
| [Archivage des phases](docs/scripts/archive-phases.md) | sort les phases terminees de "Phases" | GitHub Actions, hebdomadaire |
| [Reset des evenements recurrents](docs/scripts/reset-recurring-events.md) | reamorce "Recurring events" chaque nuit | GitHub Actions, quotidien |
| [Tasks -> Google Calendar](docs/scripts/sync-tasks-calendar.md) | projette `Deadline` / `Reminder` | GitHub Actions, quotidien |
| [Planning d'Aline](docs/scripts/sync-planning-aline.md) | projette les jours travailles | a la demande |
| [Nettoyage de la base Docs](docs/scripts/clean-docs.md) | corbeille les logs et digests relus | GitHub Actions, hebdomadaire |

Index complet et canevas commun : [`docs/scripts/README.md`](docs/scripts/README.md).

Hors flux : [l'autorisation OAuth Google](docs/scripts/google-auth.md), a lancer
une fois, et [sortir l'app OAuth du mode Testing](docs/oauth-production.md).

Le systeme Notion que ces scripts alimentent n'est pas documente ici : voir
[`CLAUDE.md`](CLAUDE.md) pour le point d'entree et la regle de frontiere.

## Arborescence

```
config/
  instance.json                   # ids des bases Notion et calendriers Google, versionne
  index.ts                        # loader type de config/instance.json
scripts/
  import-gmail.ts                 # Gmail -> Notion
  archive-phases.ts               # entretien base Phases
  reset-recurring-events.ts       # reset base Recurring events
  reset-recurring-events.test.ts  # tests de la logique de serie, sans appel Notion
  clean-docs.ts                   # entretien base Docs
  sync-tasks-calendar.ts          # Tasks -> Google Calendar
  sync-planning-aline.ts          # Planning Aline -> Google Calendar
  google-auth.ts                  # utilitaire : genere GOOGLE_REFRESH_TOKEN, a lancer une fois
  check-hardcoded-ids.ts          # CI : aucun id hors de config/
docs/
  scripts/                        # une page par script, plus leur index
  oauth-production.md             # runbook : sortir l'app OAuth du mode Testing
CLAUDE.md                         # identite du systeme, frontiere depot / Notion
.claude/skills/
  planning-aline/SKILL.md         # la tache Claude qui lit la photo du tableau
.github/workflows/                # un workflow par flux
```

## Planification

Tout tourne entre le soir et le matin, dans cet ordre (heures de Paris) :

| Heure | Script | Declencheur | Cron |
|---|---|---|---|
| 22h | `import-gmail` | GitHub Actions | `0 20 * * *` UTC |
| 2h | `reset-recurring-events` | GitHub Actions | `0 0 * * *` UTC |
| lundi 4h | `archive-phases` | GitHub Actions | `0 2 * * 1` UTC |
| dimanche 5h | `clean-docs` | GitHub Actions | `0 3 * * 0` UTC |
| 7h | `sync-tasks-calendar` | GitHub Actions | `0 5 * * *` UTC |

Trois reserves valent pour **tous** les workflows GitHub, et ne sont pas
repetees dans les pages de flux :

- **Les heures sont ecrites en UTC et ne suivent pas le changement
  d'heure.** Celles du tableau valent pour l'ete (CEST), tout glisse d'une
  heure en hiver, a corriger a la main dans le cron si besoin.
  [`reset-recurring-events`](docs/scripts/reset-recurring-events.md) est le
  seul que ce glissement n'affecte pas : seul le jour calendaire compte pour
  lui, et il le calcule dans `Europe/Paris`.
- **Un run planifie peut etre retarde** de plusieurs minutes a plusieurs
  heures selon la charge de l'infra GitHub. L'etalement ecrit dans les
  crons n'est pas celui qui est obtenu. Aucun script ne depend de l'heure de
  passage d'un autre script. Une seule dependance fixe une heure :
  `sync-tasks-calendar` passe deux heures apres la tache planifiee
  d'ingestion (documentee sur Notion, 03:00 UTC), qui pose les dates qu'il
  projette.
- **Le cron ne se declenche que sur la branche par defaut** (`main`) —
  pusher ailleurs ne suffit pas.

[`sync-planning-aline`](docs/scripts/sync-planning-aline.md) echappe au tableau : aucun
cron, il est declenche a la main (ou par la skill) quand une nouvelle photo
du tableau blanc arrive.

`npm test` lance deux choses : les tests de `reset-recurring-events` — seul
script dont le comportement depend d'un arbitrage de dates invisible a la
relecture — et `check-hardcoded-ids`, qui echoue si un UUID Notion ou un id de
calendrier Google apparait ailleurs que dans `config/instance.json`. Le
workflow [`ci.yml`](.github/workflows/ci.yml) lance `npm test` a chaque push
et pull request.

Tous les scripts lisent `.env` **relativement au repertoire courant** :
les lancer depuis la racine du repo, jamais depuis `scripts/`. Les
raccourcis `npm run` (`import:gmail`, `archive-phases`, `clean-docs`,
`google-auth`, `sync-tasks-calendar`, `sync-planning-aline`) s'en chargent.

## Prerequis communs

- Node >= 18 (fetch natif)
- `npm install`
- Une integration Notion partagee avec les bases utilisees. Chaque page de
  flux nomme les siennes ; l'ensemble couvre "Raw inputs", "Phases", "Phases
  archivees", "Tasks", "Docs", "Projects", "Sponsors", "Recurring events" et
  "Planning Aline". Leurs ids vivent dans
  [`config/instance.json`](config/instance.json).
- Un client OAuth Google, decrit ci-dessous.

### Mise en place OAuth Google

Detail complet, pieges du flux loopback et depannage :
[`docs/scripts/google-auth.md`](docs/scripts/google-auth.md).

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

Les ids de bases Notion et de calendriers Google vivent dans
[`config/instance.json`](config/instance.json), versionne — ce ne sont pas des
secrets.

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
[archivage](docs/scripts/archive-phases.md#depannage) (proprietes, `INCOMPLET`),
[Tasks Calendar](docs/scripts/sync-tasks-calendar.md#limites-connues) (scope Calendar),
[OAuth Google](docs/scripts/google-auth.md#depannage) (token, scopes).

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
