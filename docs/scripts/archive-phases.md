# Archivage des phases terminees

| | |
|---|---|
| Script | [`scripts/archive-phases.ts`](../../scripts/archive-phases.ts) |
| Declencheur | GitHub Actions, hebdomadaire `0 2 * * 1` UTC (lundi 4h a Paris en ete) |
| Secrets | `NOTION_TOKEN` |
| Lit | "Phases" (`34a8b4b8-8465-80e7-989e-ed7c68b525fa`), "Tasks" (`3438b4b8-8465-80a6-ac08-d30445212e90`), "Docs" (`3448b4b8-8465-8016-876c-df35377f3d83`) |
| Ecrit | "Phases archivees" (`3d28b4b8-8465-819d-808a-f6bdb4978194`), plus `Phase archivée` / `Phase` sur Tasks et Docs |
| Calendriers Google | aucun |

Les bases "Projects" et "Sponsors" sont referencees en lecture seule, via les
relations recopiees sur l'archive.

## Le probleme

Le selecteur de la relation `Phase` sur Tasks et Docs liste toute la base
"Phases" — Notion n'offre aucun filtre sur un selecteur de relation. Au bout
de quelques dizaines de phases, choisir devient penible. La seule facon de
reduire la liste est de sortir les phases terminees de la base.

Mais une relation Notion est liee a **une seule** data source : on ne peut pas
faire pointer `Tasks.Phase` vers une page d'une autre base, ni deplacer une
page d'une base a une autre. Le lien est donc reporte sur une **seconde
relation**, `Phase archivée`, pointant vers la base archive.

## La base "Phases archivees"

Deja creee (id `3d28b4b8-8465-819d-808a-f6bdb4978194`), sous la page
`Databases`. Schema, pour reference et pour pouvoir la recreer :

| Propriete | Type | Origine |
|---|---|---|
| `Name` | Title | copie de `Phases.Name` |
| `Project` | Relation -> Projects, limite 1, sens unique | copie |
| `Sponsor` | Relation -> Sponsors, limite 1, sens unique | copie |
| `Start date` | Date | copie |
| `Target end date` | Date | copie |
| `Deliverable` | Text | copie |
| `Status` | Select : `Done`, `Cancelled` | copie |
| `Priority` | Select : `High`, `Medium`, `Low` | copie |
| `Tasks` | Relation -> Tasks, **bidirectionnelle**, affichee cote Tasks sous le nom `Phase archivée` | ecrit par le script |
| `Docs` | Relation -> Docs, **bidirectionnelle**, affichee cote Docs sous le nom `Phase archivée` | ecrit par le script |
| `Phase source ID` | Text | id de la phase d'origine — cle d'idempotence |
| `Archived at` | Date | horodatage du run |

Les noms doivent correspondre **exactement**, accent de `Phase archivée`
compris — ce sont des cles d'API. Sens unique pour `Project`/`Sponsor` afin de
ne pas ajouter de colonne a ces deux bases.

A noter : la limite « 1 page » des relations `Project` / `Sponsor` n'est pas
exposee par l'API, elle se pose a la main dans l'UI. Sans importance, le
script n'ecrit jamais plus d'une page.

Attention au `Status` : les phases utilisent `Cancelled` (deux `l`), les Tasks
utilisent `Canceled` (un seul). Le script ne lit que celui des phases.

Les six bases concernees (Phases, Tasks, Docs, Projects, Sponsors, Phases
archivees) doivent etre partagees avec l'integration Notion, ainsi que la page
parente `Databases`.

Avant tout run reel, verifier a blanc — aucune ecriture :

```
npx tsx scripts/archive-phases.ts --dry-run
```

## Fonctionnement

Pour chaque phase dont le `Status` vaut `Done` ou `Cancelled`, dans cet ordre
strict :

1. **Creer** la page archive (ou reprendre celle d'un run interrompu,
   retrouvee par `Phase source ID`).
2. **Reattribuer** chaque Task et chaque Doc liee — requete inverse sur
   `Phase contains <id>`, pas via `Phases.Tasks` qui plafonne a 25 elements.
   Un seul PATCH par page : `Phase archivée` prend l'archive, `Phase` est
   videe.
3. **Verifier** en relisant la page : le nouveau lien est present et l'ancien
   est vide.
4. **Corbeille** de la phase d'origine, uniquement si toutes les
   verifications sont passees.

Une seule reattribution en echec suffit a conserver la phase : le script logue
l'etat incomplet, la liste des pages concernees et la commande de rollback,
puis passe a la phase suivante. Le run suivant reprend le travail sans rien
recreer.

Ce script ecrit beaucoup plus que les deux scripts d'ingestion : throttle
systematique a 350 ms et retry sur 429 / 5xx (4 tentatives, backoff
exponentiel, `Retry-After` respecte). Sans cela, un lot de phases un peu gros
part en echec au milieu d'une reattribution.

Sortie non nulle si au moins une phase est incomplete ou en echec — le run
GitHub Actions apparait alors en rouge.

## `Phase source ID` et fenetre de rollback

`Phase source ID` est une propriete **texte**, pas une relation : elle contient
l'uuid de la phase d'origine sous forme de chaine. Rien ne peut donc « casser »
dessous quand l'original disparait. Elle a deux roles.

**Idempotence.** Avant toute creation, le script cherche dans la base archive
une page dont `Phase source ID` vaut l'id de la phase. S'il en trouve une, il
la reprend au lieu d'en creer une seconde. La comparaison est chaine a chaine
dans la base archive : le script ne va jamais lire la page source, ce
garde-fou fonctionne donc meme une fois l'original detruit.

En pratique il n'est sollicite que dans la fenetre entre « archive creee » et
« phase mise a la corbeille », c'est-a-dire apres un run interrompu — une
phase en corbeille ne remonte plus dans la requete `Status = Done`. Avec une
exception, a l'intersection des deux roles : **si une phase est restauree
depuis la corbeille**, elle redevient `Done` et visible, et c'est
`Phase source ID` qui evite alors de creer une seconde page archive.

**Tracabilite.** L'id relie une page archive a sa ligne de log et a la page en
corbeille (`https://app.notion.com/p/<id sans tirets>`). Il distingue aussi
formellement deux archives homonymes — le cas s'est deja produit avec deux
phases « Mise en place ».

**Duree de vie.** Notion conserve une page en corbeille **30 jours** avant
suppression definitive. C'est la vraie fenetre de rollback, et elle porte sur
les phases, pas sur l'identifiant. Passe ce delai il n'y a plus rien a
restaurer : les deux roles operationnels s'eteignent, l'id ne subsiste que
comme empreinte de provenance. Rien n'est perdu pour autant, la page archive
etant une copie complete et non un pointeur. Autant masquer cette propriete
dans les vues de la base : elle est technique.

## Idempotence et rejeu

**Rejouer le script est sans effet de bord.** Une phase deja archivee est en
corbeille, donc hors de la requete `Status = Done | Cancelled`. Une phase
partiellement traitee est reprise sur son archive existante.

L'ordre creer -> reattribuer -> verifier -> corbeille est la garantie : a
aucun moment une Task ne se retrouve sans lien. Entre l'etape 2 et l'etape 4,
elle porte le nouveau lien ; avant l'etape 2, elle porte l'ancien.

Chaque reattribution est **relue** avant d'etre comptee. Sans cette
confirmation, rien n'est mis a la corbeille.

## Rollback

Le log du run est la trace de rollback : il contient l'id de chaque phase,
l'id de la page archive creee et l'id de chaque Task/Doc reattribuee.

- **Phase archivee a tort, moins de 30 jours** : restaurer la phase depuis la
  corbeille Notion, repointer les Tasks/Docs concernees sur `Phase`, vider
  leur `Phase archivée`, puis mettre la page archive a la corbeille.
- **Run incomplet** (`INCOMPLET` dans les logs) : la phase est toujours en
  place. Repointer les pages listees sur `Phase = <id de la phase>` comme
  l'indique le log, corriger la cause, relancer.
- **Au-dela de 30 jours** : la phase d'origine n'existe plus. La page archive
  est une copie complete, mais le corps de la page d'origine est perdu (voir
  ci-dessous).

## Lancement manuel

```
npx tsx scripts/archive-phases.ts --dry-run   # simulation
npx tsx scripts/archive-phases.ts             # pour de vrai
```

## Planification : GitHub Actions

Workflow : [`.github/workflows/archive-phases.yml`](../../.github/workflows/archive-phases.yml)

- Declenchement hebdomadaire, le lundi a `02:00` UTC (4h a Paris en ete). Voir
  les [reserves sur les crons](../../README.md#planification).
- Declenchement manuel :
  ```
  gh workflow run "Archive Phases (Notion)" --repo aagwali/scripts-notion
  ```

## Logs

```
gh run list --repo aagwali/scripts-notion --workflow "Archive Phases (Notion)" --limit 5
gh run view <run-id> --repo aagwali/scripts-notion --log
```

Les runs GitHub Actions sont conserves 90 jours. Pour un lot important
(premiere execution, reprise apres incident), lancer plutot le script en local
et garder la sortie :

```
npx tsx scripts/archive-phases.ts | tee logs/archive-phases-$(date +%F).log
```

## Limites connues

- **Le corps de la page n'est pas copie.** Le script copie les *proprietes*
  d'une phase, pas la zone de saisie libre sous les proprietes. Sans
  consequence dans l'usage actuel : les phases servent de point de
  rattachement, les 14 phases existantes au moment de la mise en place
  n'avaient aucun bloc de contenu. Si cet usage evolue, ces notes partiraient
  a la corbeille avec l'original et disparaitraient a 30 jours — il faudra
  alors soit recopier les blocs, soit refuser d'archiver une phase dont le
  corps n'est pas vide.
- **`Time spent` n'est pas repris.** La base "Phases archivees" ne porte pas
  cette propriete : le temps passe sur une phase disparait du reporting au
  moment de l'archivage. Comportement documente cote Notion et suivi au
  Backlog. A noter pour qui voudra le corriger : l'archive est creee **avant**
  le detachement des Tasks, donc la formule `Time spent` de la phase est
  encore calculee au moment ou le script pourrait la lire. Apres detachement,
  elle vaudrait `0` — l'ordre des etapes n'est pas negociable.
- **Les phases sans `Status`** ne sont jamais vues : la requete ne retient que
  `Done` et `Cancelled`.
- **Pas de traitement des Tasks orphelines** : une Task sans `Phase` ni
  `Phase archivée` n'est pas concernee par ce script.

## Depannage

- **`Notion API 400 ... is not a property that exists`** : un nom de propriete
  ne correspond pas. Verifier `Phase archivée` (avec l'accent) sur Tasks et
  Docs, et `Phase source ID` sur la base archive.
- **Phase restee en place avec `INCOMPLET` dans les logs** : c'est le
  comportement voulu, jamais de suppression apres une reattribution partielle.
  Corriger la cause (souvent un acces manquant) et relancer : le run reprend
  la phase sans recreer sa page archive.
