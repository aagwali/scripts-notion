# Tasks -> Google Calendar

| | |
|---|---|
| Script | [`scripts/sync-tasks-calendar.ts`](../../scripts/sync-tasks-calendar.ts) |
| Declencheur | GitHub Actions, quotidien `0 5 * * *` UTC (7h a Paris en ete) |
| Secrets | `NOTION_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
| Lit / ecrit | base Notion "Tasks" (config `notion.databases.tasks`) |
| Calendriers Google | `Deadlines` (config `google.calendars.deadlines`), `Reminders` (config `google.calendars.reminders`) |

## Fonctionnement

Notion reste la source de verite. Chaque tache porte deux dates independantes,
projetees chacune dans son propre calendrier Google sous forme d'evenement
**journee entiere** :

| Date Notion | Propriete portant l'id | Calendrier Google |
|---|---|---|
| `Deadline` | `Google Event Id (deadline)` | `Deadlines` |
| `Reminder` | `Google Event Id (reminder)` | `Reminders` |

L'id de l'evenement est la **seule** cle du lien — aucune recherche par titre
nulle part. Pour chaque tache et chaque couple (date, id) :

| Etat | Action |
|---|---|
| date, pas d'id | creation de l'evenement, puis ecriture de son id |
| date + id | mise a jour de l'evenement (titre, jour) |
| pas de date, id | suppression de l'evenement **et** de l'id |
| ni date ni id | rien |

Deux garde-fous s'ajoutent au tableau. Un evenement supprime a la main dans
l'agenda alors que la date existe toujours (`404`/`410` au moment du PATCH) est
**recree**, et son nouvel id reecrit : Notion fait foi. Et si la creation
reussit mais que l'ecriture de l'id echoue, le run sort en erreur en logant
l'id — sans ce rattrapage manuel, le run suivant creerait un doublon.

Un slot en echec n'empeche pas l'autre : chaque date est un lien independant,
et le run suivant reprendra celui qui a echoue.

## Ce qui est ecrit dans l'agenda

| Champ Google | Valeur |
|---|---|
| `summary` | `[Deadline] <nom de la tache>` ou `[Reminder] <nom de la tache>` |
| `start.date` / `end.date` | le jour, et le jour + 1 — une journee entiere Google a une fin **exclusive** |
| `source` | `{ title: "Notion", url: <url de la page Tasks> }` |

Le prefixe entre crochets est la seule chose qui rend un evenement
identifiable dans l'agenda, et le `source` la seule chose qui ramene a sa
tache. Ni l'un ni l'autre n'est relu par le script : ce sont des affordances
humaines, pas des cles.

Seule la partie calendaire de la date Notion est utilisee. Si une heure a ete
saisie, elle est tronquee — l'evenement produit est toujours une journee
entiere.

## Le perimetre d'un run, et le piege du troisieme cas

Sont retenues les taches modifiees dans les **30 dernieres heures**
(`Last edited`), fenetre large devant les 24h separant deux runs : un run
manque est rattrape par le suivant.

S'y ajoute un filtre sur le contenu, et c'est la que se joue la ligne « pas de
date, id ». Filtrer sur `Deadline >= aujourd'hui OU Reminder >= aujourd'hui`
exclurait mecaniquement la tache dont on vient d'effacer la date : plus de
date, donc plus de ligne remontee, donc un evenement orphelin dans l'agenda
pour toujours. Le filtre retient donc **aussi** toute tache portant un id
d'evenement, quelle que soit sa date. Une deadline passee mais encore liee est
ainsi rafraichie plutot qu'abandonnee.

Le jour de reference est calcule dans `Europe/Paris`, pas dans le fuseau du
runner : un runner GitHub est en UTC et se tromperait d'un jour a minuit.

## Idempotence et rejeu

Ecrire un id modifie la page, qui repasse donc dans la fenetre au run suivant.
Les mises a jour sont ecrites telles quelles a chaque fois, sans comparer avec
l'etat de l'evenement : un PATCH Google est idempotent, et une lecture
prealable couterait un appel de plus pour en economiser un.

**Rejouer le script est sans effet de bord** : les creations sont gardees par
la presence de l'id, les mises a jour sont idempotentes, les suppressions
tolerent un evenement deja disparu (`404`/`410` ignores, l'id Notion est
nettoye quand meme).

Le seul etat non rejouable est celui ou l'evenement existe cote Google sans
que Notion connaisse son id. Il ne peut naitre que d'un echec d'ecriture
Notion juste apres une creation — le script sort alors en erreur en affichant
l'id, precisement pour que ce trou soit refermable a la main.

## Rollback

- **Evenements crees a tort** : les supprimer dans Google Calendar et vider la
  propriete `Google Event Id (...)` correspondante dans Notion. Vider l'id
  sans supprimer l'evenement laisse un orphelin definitif.
- **Evenement supprime a tort cote Google** : ne rien faire. Tant que la date
  existe dans Notion, le run suivant le recree et reecrit l'id.
- **Id perdu cote Notion, evenement toujours la** : recopier l'id affiche dans
  le log dans la propriete, ou supprimer l'evenement a la main.
- Le log de chaque run nomme l'action, le jour et l'id pour chaque slot — c'est
  la trace de rollback.

## Reprise de l'existant (Make)

Les deux calendriers etaient alimentes par un scenario Make. Ce script reprend
les evenements en place — il ne connait que leur id, deja stocke dans Notion —
mais il les **renomme** au passage avec le prefixe `[Deadline]` / `[Reminder]`.

Deux precautions :

- **Couper le scenario Make** avant le premier run reel. Deux producteurs sur
  les memes proprietes se marcheraient dessus.
- La propriete `Google event Id (reminder)` a ete renommee
  `Google Event Id (reminder)` (casse alignee sur celle de la deadline). Tout
  scenario ou formule qui la designe par son ancien nom est a corriger.

## Lancement manuel

```
npx tsx scripts/sync-tasks-calendar.ts --dry-run   # simulation, aucun appel d'ecriture
npx tsx scripts/sync-tasks-calendar.ts             # pour de vrai
```

Le `--dry-run` n'appelle pas Google du tout : il montre le perimetre et
l'action retenue pour chaque date.

## Scope Calendar

`GOOGLE_REFRESH_TOKEN` porte les scopes accordes au moment de son emission : le
token genere pour Gmail seul **ne suffit pas**. Relancer une fois
[`google-auth.ts`](google-auth.md) (qui demande `gmail.modify` +
`calendar.events`), puis repousser le secret si le script est planifie :

```
gh secret set GOOGLE_REFRESH_TOKEN --repo aagwali/scripts-notion --body "..."
```

Les ids des deux calendriers vivent dans `config/instance.json`, comme les ids
de bases Notion — ce ne sont pas des secrets.

## Planification : GitHub Actions

Workflow : [`.github/workflows/sync-tasks-calendar.yml`](../../.github/workflows/sync-tasks-calendar.yml)

- Declenchement quotidien a `05:00` UTC (7h a Paris en ete). Voir les
  [reserves sur les crons](../../README.md#planification). L'heure suit une
  dependance : la tache planifiee d'ingestion (documentee sur Notion) passe a
  `03:00` UTC et pose `Deadline` et `Reminder` sur les Tasks qu'elle cree.
  Deux heures plus tard, ses dates partent dans l'agenda le matin meme. La
  fenetre de 30h absorbe un run manque ou retarde.
- Declenchement manuel :
  ```
  gh workflow run "Sync Tasks -> Google Calendar (Notion)" --repo aagwali/scripts-notion
  ```

## Logs

```
gh run list --repo aagwali/scripts-notion --workflow "Sync Tasks -> Google Calendar (Notion)" --limit 5
gh run view <run-id> --repo aagwali/scripts-notion --log
```

## Limites connues

- **Les noms de proprietes sont des cles d'API.** `Google Event Id (deadline)`
  et `Google Event Id (reminder)` sont codes en dur. Les renommer dans Notion
  sans modifier le script ne produit pas qu'une erreur : le script ne relirait
  plus aucun id et **recreerait tous les evenements en double** au run
  suivant. Toute harmonisation de ces noms doit donc modifier le depot
  d'abord, ou les deux dans la meme fenetre. Meme remarque pour `Deadline` et
  `Reminder`.
- **Une tache modifiee il y a plus de 30h et jamais retouchee depuis
  n'est plus vue.** Une date posee puis restee intacte pendant que le
  workflow etait casse plusieurs jours ne se rattrape pas toute seule : il
  faut rouvrir la tache, ou lancer le script a la main.
- **Pas de projection de `Due date`** : seules `Deadline` et `Reminder` sont
  synchronisees. `Due date` vit dans Notion Calendar, pas dans un calendrier
  Google.
- **Toujours des journees entieres**, meme si la date Notion porte une heure.
- Le script ne supprime jamais un evenement qu'il n'a pas cree : il ne connait
  que les ids stockes dans Notion.
