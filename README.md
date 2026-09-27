# scripts-notion

Scripts d'automatisation autour d'un meme espace Notion, partageant une
seule integration (`NOTION_TOKEN`) et un seul jeu de dependances : ingestion
Gmail, projections vers Google Calendar, entretien des bases.

**Index des scripts** : [`docs/scripts/README.md`](docs/scripts/README.md), une
page par script (fonctionnement, rejeu, rollback, pannes propres). Cette page-ci
ne porte que ce qui leur est commun : prerequis, planification, variables,
logs et pannes transverses.

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
  roll-post-it.ts                 # report quotidien du calendrier Post-it
  roll-post-it.test.ts            # tests de la frontiere "passe", sans appel Google
  google-auth.ts                  # utilitaire : genere GOOGLE_REFRESH_TOKEN, a lancer une fois
  check-hardcoded-ids.ts          # CI : aucun id hors de config/
docs/
  scripts/                        # une page par script, plus leur index
  oauth-production.md             # app OAuth en mode Testing : motif, issues, pieges
CLAUDE.md                         # frontiere depot / Notion, regles de session
.claude/skills/
  planning-aline/SKILL.md         # la tache Claude qui lit la photo du tableau
.github/workflows/                # un workflow par flux
```

## Planification

Tout tourne entre le soir et le matin, dans cet ordre (heures de Paris en
ete, sauf `reset-recurring-events`, cale sur minuit UTC) :

| Heure | Script | Declencheur | Cron |
|---|---|---|---|
| 22h | `import-gmail` | GitHub Actions | `0 20 * * *` UTC |
| minuit UTC | `reset-recurring-events` | GitHub Actions | `0 0 * * *` UTC |
| lundi 4h | `archive-phases` | GitHub Actions | `0 2 * * 1` UTC |
| dimanche 5h | `clean-docs` | GitHub Actions | `0 3 * * 0` UTC |
| 6h | `roll-post-it` | GitHub Actions | `0 4 * * *` UTC |
| 7h | `sync-tasks-calendar` | GitHub Actions | `0 5 * * *` UTC |

Trois reserves valent pour **tous** les workflows GitHub, et ne sont pas
repetees dans les pages de script :

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

`npm test` lance trois choses : les tests de `reset-recurring-events` et de
`roll-post-it` — les deux scripts dont le comportement depend d'un arbitrage
de dates invisible a la relecture — et `check-hardcoded-ids`, qui echoue si un UUID Notion ou un id de
calendrier Google apparait ailleurs que dans `config/instance.json`. Le
workflow [`ci.yml`](.github/workflows/ci.yml) lance `npm test` a chaque push
et pull request.

Tous les scripts lisent `.env` **relativement au repertoire courant** :
les lancer depuis la racine du repo, jamais depuis `scripts/`. Les
raccourcis `npm run` (`import:gmail`, `archive-phases`, `clean-docs`,
`google-auth`, `sync-tasks-calendar`, `sync-planning-aline`, `roll-post-it`) s'en chargent.

## Prerequis communs

- Node >= 18 (fetch natif)
- `npm install`
- Une integration Notion partagee avec les bases utilisees. Chaque page de
  script nomme les siennes ; l'ensemble couvre "Raw inputs", "Phases", "Phases
  archivees", "Tasks", "Docs", "Projects", "Sponsors", "Recurring events" et
  "Planning Aline". Leurs ids vivent dans
  [`config/instance.json`](config/instance.json).
- Un client OAuth Google, decrit ci-dessous.

### Mise en place OAuth Google

Detail complet, pieges du flux loopback et depannage :
[`docs/scripts/google-auth.md`](docs/scripts/google-auth.md).

Un **seul** client OAuth couvre Gmail et Calendar : `google-auth.ts`
demande les deux scopes (`gmail.modify` + `calendar.events`) en une fois,
et le refresh token obtenu sert a tous les flux Google du repo. Le
recapitulatif de `clean-docs` part avec le meme `gmail.modify`, qui couvre
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
   > Pourquoi l'app y reste : [`docs/oauth-production.md`](docs/oauth-production.md).
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
(`Settings > Secrets and variables > Actions`) pour les workflows :

```
gh secret set NOTION_TOKEN --repo aagwali/scripts-notion --body "..."
gh secret set GOOGLE_CLIENT_ID --repo aagwali/scripts-notion --body "..."
gh secret set GOOGLE_CLIENT_SECRET --repo aagwali/scripts-notion --body "..."
gh secret set GOOGLE_REFRESH_TOKEN --repo aagwali/scripts-notion --body "..."
```

Les ids de bases Notion et de calendriers Google vivent dans
[`config/instance.json`](config/instance.json), versionne — ce ne sont pas des
secrets.

## Consulter les logs

Chaque page de script donne le nom de son workflow et ce que dit son log.
Deux points valent pour tous les workflows GitHub :

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

Pannes transverses. Les pannes propres a un script sont sur sa page :
[archivage](docs/scripts/archive-phases.md#depannage) (proprietes, `INCOMPLET`),
[Tasks Calendar](docs/scripts/sync-tasks-calendar.md#limites-connues) (scope Calendar),
[OAuth Google](docs/scripts/google-auth.md#depannage) (token, scopes).

- **`Variables d'environnement manquantes`** : verifier `.env` —
  attention au format, `client id : xxx` n'est PAS une syntaxe valide, il
  faut `GOOGLE_CLIENT_ID=xxx`.
- **Rafraichissement Google refuse** : si l'app OAuth est en mode
  Testing, le refresh token expire au bout de 7 jours — relancer
  `npx tsx scripts/google-auth.ts` et repousser le secret. Voir
  [`docs/oauth-production.md`](docs/oauth-production.md).
- **`Notion API 404` sur une base** : l'integration n'a pas acces a la
  base. Un 404 Notion signifie "invisible pour ce token", pas
  "inexistant" — partager la base depuis son menu `...` > `Connexions`.
