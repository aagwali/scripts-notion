# Planning d'Aline -> Google Calendar

Fichier : [`scripts/sync-planning-aline.ts`](../scripts/sync-planning-aline.ts)
Tache Claude : [`.claude/skills/planning-aline/SKILL.md`](../.claude/skills/planning-aline/SKILL.md)
Base concernee : "Planning Aline" (`8042d9c1-3ea1-481d-a64e-b48d9a138f19`)

Seul flux du repo lance a la demande, sans aucun cron.

## Le besoin

Aline travaille une quinzaine de jours par mois, en deux horaires : `H1`
(6h30-18h30) et `H2` (7h30-19h30). Son planning n'existe que sous une
seule forme, un tableau blanc mensuel a la maison, rempli au feutre. Les
jours ou elle travaille, les trajets scolaires me reviennent : ces
jours-la le teletravail est obligatoire, et cette contrainte doit etre
visible dans mon agenda au moment ou je pose mes rendez-vous.

## La chaine

```
photo -> [skill Claude] -> Notion -> [gh workflow run] -> Actions -> Google Calendar
```

La lecture de la photo revient a Claude : reconnaitre du `H1` manuscrit
et deduire le mois d'une grille qui ne le nomme pas ne se scripte pas
raisonnablement. Claude ecrit une ligne par jour dans la base, puis
declenche le workflow.

L'ecriture dans l'agenda revient au script, pour deux raisons. La photo
se lit souvent depuis un telephone, ou aucun `.env` n'est disponible :
les credentials Google sont dans les secrets du repo, donc le sync doit
tourner sur un runner. Et surtout, Claude sans etat qui appellerait
l'API Calendar dupliquerait les evenements a la seconde passe. Le script
n'achete pas l'insertion, il achete l'idempotence.

Le declenchement passe par `workflow_dispatch`, pas par un cron pousse
sur `main` : un cron GitHub peut etre retarde de plusieurs heures (voir
les [reserves sur les crons](../README.md#planification)), et n'est de
toute facon pas one-shot.

## Deux destinations

| | Jours travailles | Rendez-vous |
|---|---|---|
| Ligne Notion | `Type = Travail` | `Type = RDV` |
| Calendrier | `Planning Aline` (dedie) | `adrienagwali@gmail.com` (perso) |
| Titre | `H1 · 6h30-18h30` | le libelle lu sur le tableau |
| Forme | journee entiere | journee entiere, ou horaire si la date Notion porte une heure |

Les horaires ne sont **pas** dans Notion : ils sont codes en dur dans
`SHIFTS`. Le tableau ne porte que les codes, et une base qui repeterait
"6h30-18h30" sur treize lignes finirait par se contredire.

## Idempotence : le tag, et le sens unique

Le calendrier personnel est tenu a la main : y reconcilier une fenetre de
dates effacerait des saisies manuelles. Chaque evenement ecrit par le
script porte donc un tag dans `extendedProperties.private`, sur lequel
`events.list` sait filtrer. Le script devient proprietaire d'une fenetre
*virtuelle* a l'interieur du calendrier, ou tout ce qui a ete saisi a la
main est litteralement invisible a la requete.

Le meme mecanisme est applique au calendrier dedie, ou il ne serait pas
necessaire. C'est delibere : le planning est importe une fois par mois
puis retouche **directement dans Google Calendar**, jamais dans Notion.
Une reconciliation par fenetre ecraserait ces retouches au premier
re-run venu — relance d'un run echoue, double declenchement du workflow.

D'ou le regime par defaut, identique des deux cotes : **sens unique**. Le
tag sert uniquement a ne pas creer deux fois. Un evenement deja pose
n'est ni modifie ni supprime, quoi qu'en dise Notion. Relancer le
workflow sur un mois deja importe ne produit donc rien — ni doublon, ni
correction.

L'inverse reste accessible par `--reconcile` (input `reconcile` du
workflow) : les evenements tagues sont alignes sur Notion et ceux dont la
ligne a disparu sont supprimes. Il sert a rattraper une photo mal lue —
on corrige la base, on relance en reconciliation. C'est un geste
explicite parce qu'il detruit les retouches manuelles.

La requete des evenements tagues n'a volontairement aucune borne de date :
elle filtre sur le seul tag de mois. Un evenement deplace a la main hors
du mois reste retrouve, et n'est donc pas recree en double.

## Le calendrier dedie

`Planning Aline`
(`affbc5703ccd88c8fd08e946acf97e75cd87896faea2411eda2c7f31c8971b4e`) est
cree **a la main** dans l'UI Google Calendar. Le scope `calendar.events`
du refresh token partage permet d'ecrire des evenements, pas de creer un
calendrier ; elargir ce scope en permanence pour une creation unique ne
se justifie pas. Son id est code en dur, comme les autres ids de
calendriers du repo — ce ne sont pas des secrets.

## Lancement

Depuis n'importe ou, via le workflow
[`.github/workflows/sync-planning-aline.yml`](../.github/workflows/sync-planning-aline.yml)
(`workflow_dispatch` uniquement, pas de cron) :

```
gh workflow run "Sync Planning Aline -> Google Calendar" \
  --repo aagwali/scripts-notion -f month=2026-09
gh workflow run "Sync Planning Aline -> Google Calendar" \
  --repo aagwali/scripts-notion -f month=2026-09 -f dry_run=true
gh workflow run "Sync Planning Aline -> Google Calendar" \
  --repo aagwali/scripts-notion -f month=2026-09 -f reconcile=true
```

En local, si le `.env` est disponible :

```
npx tsx scripts/sync-planning-aline.ts --dry-run              # mois courant, simulation
npx tsx scripts/sync-planning-aline.ts --month 2026-09
npx tsx scripts/sync-planning-aline.ts --month 2026-09 --reconcile
```

Sans `--month` / `month`, le mois courant est calcule dans
`Europe/Paris` — pas dans le fuseau du runner, qui se tromperait de mois
le 1er a minuit.

Le `workflow_dispatch` n'apparait dans `gh` qu'une fois le fichier de
workflow present sur `main`.

## Logs

```
gh run list --repo aagwali/scripts-notion --workflow "Sync Planning Aline -> Google Calendar" --limit 5
gh run view <run-id> --repo aagwali/scripts-notion --log
```
