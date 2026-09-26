# Documentation des scripts

Une page par script de [`scripts/`](../../scripts). Chacune suit le meme
canevas : role, declencheur, entrees, sorties (bases Notion et calendriers
Google touches), idempotence et comportement en cas de rejeu, secrets requis,
procedure de rollback, limites connues.

**Ces pages ne documentent que le code de ce depot.** L'architecture des bases
Notion, le parcours utilisateur et les modes operatoires des taches planifiees
vivent sur Notion et s'y lisent via le MCP — voir
[`CLAUDE.md`](../../CLAUDE.md) pour la regle de frontiere et le point d'entree.

## Ingestion

Alimente la base "Raw inputs" en `Status = To process`. Le consommateur est
une tache planifiee claude.ai, documentee sur Notion.

| Doc | Script | Declencheur |
|---|---|---|
| [Gmail -> Notion](import-gmail.md) | `import-gmail.ts` | Actions, quotidien 22h |

"Raw inputs" recoit aussi des lignes qu'aucun script d'ici n'ecrit — voir
[plus bas](#ce-quaucun-script-de-ce-depot-ne-fait).

## Projection vers Google Calendar

| Doc | Script | Declencheur |
|---|---|---|
| [Tasks -> Google Calendar](sync-tasks-calendar.md) | `sync-tasks-calendar.ts` | Actions, quotidien 7h |
| [Planning d'Aline](sync-planning-aline.md) | `sync-planning-aline.ts` | a la demande, aucun cron |

## Entretien des bases Notion

| Doc | Script | Declencheur |
|---|---|---|
| [Reset des evenements recurrents](reset-recurring-events.md) | `reset-recurring-events.ts` | Actions, quotidien minuit |
| [Nettoyage de la base Docs](clean-docs.md) | `clean-docs.ts` | Actions, dimanche 5h |
| [Archivage des phases](archive-phases.md) | `archive-phases.ts` | Actions, lundi 4h |

## Utilitaire

| Doc | Script | Declencheur |
|---|---|---|
| [Autorisation OAuth Google](google-auth.md) | `google-auth.ts` | manuel, une seule fois |

## Ailleurs

- [`docs/oauth-production.md`](../oauth-production.md) — runbook pour sortir
  l'app OAuth du mode Testing. Une procedure, pas un script.
- [`README.md`](../../README.md) — prerequis communs, tableau de planification,
  variables d'environnement, pannes transverses.

## Ce qu'aucun script de ce depot ne fait

A verifier avant de chercher un bug au mauvais endroit :

- **La capture vocale** n'a pas de script ici : elle ecrit directement dans
  "Raw inputs" (`Channel = Vocal`), sans passer par le depot.
- **La base "Meetings"** n'est ecrite par aucun script d'ici. Elle l'est par la
  tache planifiee claude.ai, depuis les reunions dictees en capture vocale.
- **La classification** (Task / Doc / input brief), la pose du label `Traité`, les
  labels metier : tache planifiee claude.ai, pas ce depot. L'ingestion ne pose
  que `Importé`.
- **Le calendrier `EDF`** est alimente a la main. Un script d'import est
  envisage, il n'existe pas.
- **La base "Planning Aline"** est ecrite par la skill
  [`planning-aline`](../../.claude/skills/planning-aline/SKILL.md), pas par
  `sync-planning-aline.ts`, qui ne fait que la lire.
