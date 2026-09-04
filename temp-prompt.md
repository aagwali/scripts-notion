# Contexte

Ce repo contient déjà des scripts TypeScript interagissant avec Gmail et Notion.
Je veux ajouter un nouveau script, planifié via GitHub Actions, qui synchronise
des dates de ma base Notion "Tasks" vers Google Calendar.

Cette logique existe déjà et fonctionne dans Make (outil no-code) — je la migre
en TypeScript. La spec ci-dessous est le comportement validé en production, à
reproduire fidèlement.

# Avant de coder

1. Explore le repo pour comprendre les conventions existantes : structure des
   dossiers, gestion des secrets/env, client Notion utilisé (SDK officiel ou
   fetch brut ?), style de code, gestion d'erreurs, tests s'il y en a.
2. Réutilise l'existant plutôt que d'introduire de nouvelles dépendances ou
   patterns si un équivalent est déjà en place (notamment pour l'auth Notion).
3. Dis-moi ce que tu as trouvé et comment tu comptes t'intégrer avant d'écrire
   le code.

# Spec fonctionnelle

## Source
Data source Notion "Tasks" : `3438b4b8-8465-805e-9160-000bea5591f4`

Propriétés utilisées :
| Propriété | Type | Rôle |
|---|---|---|
| `Name` | title | titre de l'événement GCal |
| `Deadline` | date | axe 1 |
| `Reminder` | date | axe 2 |
| `Google Event Id (deadline)` | rich_text | ID de l'event GCal de l'axe 1 |
| `Google event Id (reminder)` | rich_text | ID de l'event GCal de l'axe 2 (attention : casse différente du précédent, c'est volontaire, c'est le nom réel) |
| `Last edited` | last_edited_time | filtrage |

## Déclenchement
GitHub Actions, 1 run/jour (cron).

## Sélection des Tasks à traiter
Requête Notion filtrée :

`Last edited >= now - 30h`
ET au moins une des conditions suivantes :
- `Deadline >= aujourd'hui`
- `Deadline` vide ET `Google Event Id (deadline)` non vide
- `Reminder >= aujourd'hui`
- `Reminder` vide ET `Google event Id (reminder)` non vide

(La fenêtre de 30h > 24h est volontaire : marge de rattrapage si un run échoue.)

## Traitement
Pour chaque Task, traiter les deux axes indépendamment (deadline et reminder) :

date renseignée + pas d'event ID → créer event GCal + écrire l'ID sur la Task
date renseignée + event ID stocké → update l'event GCal (nouvelle date)
date vide + event ID stocké → supprimer l'event GCal + vider l'ID sur la Task
date vide + pas d'event ID → ne rien faire

## Contraintes
- **Sens unique strict** : jamais de remontée Google Calendar → Notion. Les
  déplacements manuels dans le calendrier sont assumés comme informatifs.
- Calendrier Google cible : dédié, ID à mettre en variable d'environnement.
- Les événements sont des all-day si la date Notion n'a pas d'heure, sinon
  avec heure.
- Différencier les titres des deux axes (ex. `Deadline: {Name}` / `Rappel: {Name}`)
  pour les distinguer dans le calendrier.
- Pour vider une propriété rich_text via l'API Notion, envoyer `rich_text: []`.

# Ce que j'attends

- Le script TypeScript
- Le workflow GitHub Actions (cron quotidien)
- La liste exacte des secrets à configurer dans le repo
- Des logs suffisamment parlants pour débugger un run raté sans avoir à
  reproduire en local

Pose-moi des questions si un point de la spec est ambigu plutôt que de supposer.
Deux points à compléter : l'ID du calendrier Google cible, et le mode d'authentification Google.