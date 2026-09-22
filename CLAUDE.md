# scripts-notion — poste de travail du système SPPT

## Ce qu'est ce système

Méthode **SPPT — Sponsor · Projet · Phase · Tâche**, déclinée dans un espace
Notion, les Pomodoros servant de ledger de temps. Deux axes :

- **action** — capture, planification, exécution : Tasks, Recurring events, Pomodoros ;
- **connaissance** — base documentaire unifiée : Docs.

Ce dépôt n'est pas le système. Il porte les scripts qui l'alimentent et
l'entretiennent : ingestion d'emails, projections vers Google Calendar,
archivage et nettoyage des bases. Le système, lui, vit dans Notion.

## Source de vérité

**🗂️ Index — Système SPPT**
<https://app.notion.com/p/3da8b4b88465817e955edeb15272ed51>

À lire au début de toute session, via le MCP Notion. Cette page pointe vers la
référence d'architecture, le guide de parcours, le backlog et les instructions
de run. L'état réel du workspace prime sur toute doc, y compris sur elle.

## Frontière dépôt / Notion

> La documentation du système SPPT et les instructions opérationnelles des tâches
> planifiées vivent EXCLUSIVEMENT sur Notion, et s'y lisent et s'y éditent via le
> MCP Notion. Ne jamais les copier, résumer ni dupliquer dans ce dépôt : les
> tâches planifiées claude.ai n'ont pas accès au dépôt, et une copie locale
> divergerait en silence. Le dépôt ne documente que le code qu'il contient.

Une seule exception, et elle ne contredit pas la règle :
`.claude/skills/planning-aline/` est lue par Claude Code **depuis ce dépôt**,
jamais par une tâche claude.ai, et elle pilote un script d'ici. Le motif de la
règle — l'inaccessibilité du dépôt — ne s'y applique pas. La déplacer sur
Notion la rendrait inopérante : une skill ne se déclenche que depuis
`.claude/skills/`.

## Règle de mise à jour

> Une modification de propriété, base, relation, formule ou vue, ou un changement
> de comportement d'un script, impose la mise à jour du doc de référence concerné
> dans la même session. Un écart constaté mais non corrigé part en ligne du
> Backlog. Aucun écart ne reste non écrit.

> **La doc dit l'état cible, jamais son évolution.** Le corps d'un doc — ici
> comme sur Notion — décrit le comportement en vigueur comme s'il avait toujours
> été ainsi. Proscrits : « désormais », « ne fait plus », « l'ancien X est
> supprimé », « au lieu de », « ex-tâche ». Un *motif* de conception s'écrit et
> se garde, il explique pourquoi la règle est ce qu'elle est ; un *historique* ne
> s'écrit pas — il vit dans git et dans le Backlog.

## Limitations connues

- **Plan Notion gratuit** : pas d'automation native. Tout automatisme vient d'un
  script de ce dépôt ou d'une tâche planifiée claude.ai.
- **Rollup de rollup refusé.** Parade : `prop("Relation").map(current.prop("Prop")).sum()`.
- **Relations mono-cible** : pas de relation polymorphe. D'où la double relation
  `Task` / `Event` sur Pomodoros, et `Phase` / `Phase archivée` sur Tasks et Docs.
- **Formules non lisibles via MCP** : le code d'une formule n'est pas exposé en
  lecture. La section *Formules* de la référence d'architecture est la seule
  source consultable par un agent.
- **Deux espaces d'identifiants.** Les scripts appellent l'API REST et portent des
  `database_id` ; le MCP et l'Index manipulent des `collection://` (data source id).
  Les deux désignent la même base sans se ressembler. Ne jamais conclure à un
  écart sur cette seule base.
- **Noms de propriétés = clés d'API.** Renommer une propriété dans Notion casse
  en silence le script qui l'écrit, accents et casse compris (`Phase archivée`,
  `Google Event Id (deadline)`). Vérifier les scripts avant tout renommage.

## Règles d'interaction

- **Ne jamais supposer l'état d'une base.** Les propriétés peuvent avoir changé
  entre deux sessions : vérifier via le MCP avant d'agir.
- **Annoncer l'impact avant toute modification structurelle** (propriété, base,
  relation, formule, vue) : quelles autres bases, quels scripts, quels docs — et
  attendre l'arbitrage.
- **Code et doc en désaccord** : le signaler, ne trancher ni dans un sens ni dans
  l'autre. L'arbitrage revient à l'utilisateur.

## Le dépôt

- `scripts/` — un fichier par flux, TypeScript exécuté par `tsx`.
- `.github/workflows/` — planification GitHub Actions.
- `docs/scripts/` — un doc par script : ce que fait le code, jamais ce que fait
  le système. Index dans [`docs/scripts/README.md`](docs/scripts/README.md).
- `.claude/skills/planning-aline/` — lecture de la photo du planning.

Quatre secrets, jamais dans le dépôt : `NOTION_TOKEN`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. En local dans `.env` (gabarit
dans `.env.example`), en CI dans les secrets du repo.
