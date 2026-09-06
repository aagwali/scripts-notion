# Tasks -> Google Calendar

Fichier : [`scripts/sync-tasks-calendar.ts`](../scripts/sync-tasks-calendar.ts)
Base concernee : "Tasks" (`3438b4b8-8465-80a6-ac08-d30445212e90`)

## Fonctionnement

Notion reste la source de verite. Chaque tache porte deux dates
independantes, projetees chacune dans son propre calendrier Google sous
forme d'evenement **journee entiere**, titre `[Deadline] <nom>` ou
`[Reminder] <nom>` :

| Date Notion | Propriete portant l'id | Calendrier Google |
|---|---|---|
| `Deadline` | `Google Event Id (deadline)` | `Deadlines` |
| `Reminder` | `Google Event Id (reminder)` | `Reminders` |

L'id de l'evenement est la **seule** cle du lien — aucune recherche par
titre nulle part. Pour chaque tache et chaque couple (date, id) :

| Etat | Action |
|---|---|
| date, pas d'id | creation de l'evenement, puis ecriture de son id |
| date + id | mise a jour de l'evenement (titre, jour) |
| pas de date, id | suppression de l'evenement **et** de l'id |
| ni date ni id | rien |

Deux garde-fous s'ajoutent au tableau. Un evenement supprime a la main
dans l'agenda alors que la date existe toujours (`404`/`410` au moment du
PATCH) est **recree**, et son nouvel id reecrit : Notion fait foi. Et si
la creation reussit mais que l'ecriture de l'id echoue, le run sort en
erreur en logant l'id — sans ce rattrapage manuel, le run suivant
creerait un doublon.

## Le perimetre d'un run, et le piege du troisieme cas

Sont retenues les taches modifiees dans les **30 dernieres heures**
(`Last edited`), fenetre large devant les 24h separant deux runs : un run
manque est rattrape par le suivant.

S'y ajoute un filtre sur le contenu, et c'est la que se joue la ligne
"pas de date, id". Filtrer sur `Deadline >= aujourd'hui OU Reminder >=
aujourd'hui` exclurait mecaniquement la tache dont on vient d'effacer la
date : plus de date, donc plus de ligne remontee, donc un evenement
orphelin dans l'agenda pour toujours. Le filtre retient donc **aussi**
toute tache portant un id d'evenement, quelle que soit sa date.

Ecrire un id modifie la page, qui repasse donc dans la fenetre au run
suivant. Les mises a jour sont ecrites telles quelles a chaque fois, sans
comparer avec l'etat de l'evenement : un PATCH Google est idempotent, et
une lecture prealable couterait un appel de plus pour en economiser un.

## Reprise de l'existant (Make)

Les deux calendriers etaient alimentes par un scenario Make. Ce script
reprend les evenements en place — il ne connait que leur id, deja stocke
dans Notion — mais il les **renomme** au passage avec le prefixe
`[Deadline]` / `[Reminder]`.

Deux precautions :

- **Couper le scenario Make** avant le premier run reel. Deux producteurs
  sur les memes proprietes se marcheraient dessus.
- La propriete `Google event Id (reminder)` a ete renommee
  `Google Event Id (reminder)` (casse alignee sur celle de la deadline).
  Tout scenario ou formule qui la designe par son ancien nom est a
  corriger.

## Lancement manuel

```
npx tsx scripts/sync-tasks-calendar.ts --dry-run   # simulation, aucun appel d'ecriture
npx tsx scripts/sync-tasks-calendar.ts             # pour de vrai
```

Le `--dry-run` n'appelle pas Google du tout : il montre le perimetre et
l'action retenue pour chaque date.

## Scope Calendar

`GOOGLE_REFRESH_TOKEN` porte les scopes accordes au moment de son
emission : le token genere pour Gmail seul **ne suffit pas**. Relancer
une fois `npx tsx scripts/google-auth.ts` (qui demande desormais
`gmail.modify` + `calendar.events`), puis repousser le secret si le
script est planifie :

```
gh secret set GOOGLE_REFRESH_TOKEN --repo aagwali/scripts-notion --body "..."
```

Les ids des deux calendriers sont codes en dur dans le script, comme les
ids de bases Notion — ce ne sont pas des secrets.

## Planification : GitHub Actions

Workflow : [`.github/workflows/sync-tasks-calendar.yml`](../.github/workflows/sync-tasks-calendar.yml)

- Declenchement quotidien a `00:00` UTC (2h a Paris en ete). Voir les
  [reserves sur les crons](../README.md#planification).
- Secrets requis : `NOTION_TOKEN`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.
- Declenchement manuel :
  ```
  gh workflow run "Sync Tasks -> Google Calendar (Notion)" --repo aagwali/scripts-notion
  ```

## Logs

```
gh run list --repo aagwali/scripts-notion --workflow "Sync Tasks -> Google Calendar (Notion)" --limit 5
gh run view <run-id> --repo aagwali/scripts-notion --log
```

## Depannage

- **`Calendar API 403 ... insufficientPermissions`** : le refresh token a
  ete emis avant l'ajout du scope Calendar. Relancer
  `npx tsx scripts/google-auth.ts` (verifier aussi que l'API Google
  Calendar est activee sur le projet Cloud).
