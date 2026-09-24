---
name: planning-aline
description: Lire la photo du planning mensuel d'Aline (tableau blanc, jours H1/H2 ecrits a la main), ecrire le releve dans la base Notion "Planning Aline", puis declencher le workflow GitHub qui le projette vers Google Calendar. A utiliser des qu'une photo de ce tableau est fournie, ou quand on demande de mettre a jour / resynchroniser le planning d'Aline.
---

# Planning d'Aline : photo -> Notion -> Google Calendar

Aline travaille une quinzaine de jours par mois, en deux horaires :

| Code | Horaire |
|---|---|
| `H1` | 6h30 - 18h30 |
| `H2` | 7h30 - 19h30 |

**L'enjeu reel n'est pas son agenda, c'est celui d'Adrien** : les jours ou
elle travaille, il assure les trajets scolaires et doit donc etre en
teletravail. Une erreur de lecture se paie par une journee de bureau
impossible a annuler — d'ou la verification de coherence de l'etape 3,
qui n'est pas optionnelle.

Trois etapes, dans cet ordre :

1. **Lire la photo** et en tirer un releve. Seule etape qui demande de
   l'interpretation visuelle, et seule raison d'etre de cette skill.
2. **Ecrire dans Notion**, base "Planning Aline" (id dans
   `config/instance.json` → `notion.databases.planningAline`). Une ligne par
   jour.
3. **Declencher le workflow GitHub**, qui lance
   `scripts/sync-planning-aline.ts` sur un runner.

Ne jamais ecrire dans Google Calendar directement. Les credentials Google
vivent dans les secrets du repo, et c'est le script qui porte
l'idempotence — pas cette skill.

## 1. Determiner le mois

Le tableau ne porte **jamais** le nom du mois. Il se deduit, et la
deduction se verifie :

- Colonnes = lundi -> dimanche. Relever le numero de la premiere case de
  la premiere ligne et sa colonne, et le dernier numero du mois (28, 29,
  30 ou 31).
- Chercher, **dans l'annee en cours**, le mois qui a cette longueur et
  dont le 1er tombe le bon jour de la semaine. Verifier avec
  `date -j -f "%Y-%m-%d" "AAAA-MM-01" "+%A"`.
- Les cases debordantes (fin du mois precedent en tete de grille) portent
  des numeros plus grands que le dernier jour du mois : elles confirment
  la deduction, et **ne sont pas reprises dans Notion** — elles
  appartiennent au mois d'avant.
- Recouper avec les indices ecrits sur le tableau ("RENTREE" en
  septembre, "Noel", un jour ferie...).

Si deux mois de l'annee collent, **demander** — ne pas trancher au
hasard.

## 2. Relever les cases

Pour chaque case : le numero du jour, et ce qui est ecrit dedans.

- `H1` / `H2` -> jour travaille.
- Une case vide -> Aline ne travaille pas. C'est une information, pas une
  absence de donnee.
- Une **diagonale** barrant une case marque un jour ecoule au moment de
  la photo. Elle ne dit rien sur le travail : si la case barree contient
  `H1`, le jour compte. On ecrit le passe comme le reste.
- Tout autre texte (`PHOTO`, un nom de medecin avec une heure, `Pot
  depart`, `RENTREE`) -> rendez-vous, `Type = RDV`.
- Le `H` manuscrit se distingue mal d'autres lettres, et le `1` du `2` sur
  une photo floue. En cas de doute reel sur une case, **demander** plutot
  que de trancher.

## 3. Verifier la coherence avant d'ecrire

Trois controles, tous a passer :

1. **Alignement colonne / date.** Pour 3 ou 4 cases reparties dans le
   mois, verifier que le jour de la semaine deduit de la date correspond
   bien a la colonne ou la case se trouve. Un decalage d'un cran
   invalide toute la lecture.
2. **Continuite.** Les numeros se suivent sans trou ni doublon, de 1 au
   dernier jour du mois.
3. **Volume.** Le total doit tomber autour de 13 a 16 jours travailles.
   Nettement en dehors, c'est le signe d'une case mal lue.

Presenter le releve (dates + jour de la semaine + horaire) et le faire
valider avant d'ecrire quoi que ce soit.

## 4. Ecrire dans Notion

Base "Planning Aline" (id dans `config/instance.json` →
`notion.databases.planningAline`) :

| Propriete | Jour travaille | Rendez-vous |
|---|---|---|
| `Name` | le code horaire (`H1`, `H2`) | le libelle lu sur le tableau |
| `Date` | le jour, sans heure | le jour, **avec** l'heure si le tableau en donne une |
| `Type` | `Travail` | `RDV` |
| `Horaire` | `H1` ou `H2` | vide |
| `Lu le` | date du jour | date du jour |

Une heure sur `Date` n'a de sens que pour un `RDV` : elle produit un
evenement horaire au lieu d'une journee entiere.

**Avant d'ecrire, interroger la base sur le mois vise.** Si des lignes
existent deja, ne pas empiler : montrer ce qui est en place et demander
s'il faut completer ou remplacer (dans ce cas, supprimer les lignes du
mois avant de recreer). Le script en aval refuse deux jours travailles
sur la meme date.

## 5. Declencher le sync

```
gh workflow run "Sync Planning Aline -> Google Calendar" \
  --repo aagwali/scripts-notion -f month=2026-09
```

`month` peut etre omis : le script prend alors le mois courant a Paris.
Pour verifier :

```
gh run list --repo aagwali/scripts-notion --workflow "Sync Planning Aline -> Google Calendar" --limit 1
gh run view <run-id> --repo aagwali/scripts-notion --log
```

En local, si le `.env` est disponible :

```
npx tsx scripts/sync-planning-aline.ts --month 2026-09 --dry-run
npx tsx scripts/sync-planning-aline.ts --month 2026-09
```

## Ce qu'il faut savoir avant de relancer un mois deja synchronise

Le sync est **a sens unique** : un evenement deja pose dans l'agenda
n'est ni modifie ni supprime, quoi que dise Notion. C'est voulu — le
planning est retouche directement dans Google Calendar, et une
reconciliation ecraserait ces retouches au premier re-run.

Consequence : **relancer le workflow sur un mois deja importe ne change
rien**. Ni doublon, ni correction.

Pour qu'une correction faite dans Notion redescende, il faut le demander
explicitement, avec `reconcile` :

```
gh workflow run "Sync Planning Aline -> Google Calendar" \
  --repo aagwali/scripts-notion -f month=2026-09 -f reconcile=true
```

La reconciliation aligne les evenements tagues sur Notion et supprime
ceux dont la ligne a disparu. Elle detruit les retouches manuelles : ne
la proposer que pour rattraper une photo mal lue, et le dire.
