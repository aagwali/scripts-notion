# Planning d'Aline -> Google Calendar

| | |
|---|---|
| Script | [`scripts/sync-planning-aline.ts`](../../scripts/sync-planning-aline.ts) |
| Tache Claude | [`.claude/skills/planning-aline/SKILL.md`](../../.claude/skills/planning-aline/SKILL.md) |
| Declencheur | `workflow_dispatch` uniquement — **aucun cron** |
| Secrets | `NOTION_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
| Lit | base Notion "Planning Aline" (config `notion.databases.planningAline`) |
| Ecrit | calendriers `Planning Aline` (config `google.calendars.planningAline`) et perso (`google.calendars.personal`) |

Seul flux du repo lance a la demande. Le script n'ecrit **jamais** dans Notion :
il ne fait que lire la base et poser des evenements.

## Le besoin

Aline travaille une quinzaine de jours par mois, en deux horaires : `H1`
(6h30-18h30) et `H2` (7h30-19h30). Son planning n'existe que sous une seule
forme, un tableau blanc mensuel a la maison, rempli au feutre. Les jours ou
elle travaille, les trajets scolaires me reviennent : ces jours-la le
teletravail est obligatoire, et cette contrainte doit etre visible dans mon
agenda au moment ou je pose mes rendez-vous.

## La chaine

```
photo -> [skill Claude] -> Notion -> [gh workflow run] -> Actions -> Google Calendar
```

La lecture de la photo revient a Claude : reconnaitre du `H1` manuscrit et
deduire le mois d'une grille qui ne le nomme pas ne se scripte pas
raisonnablement. Claude ecrit une ligne par jour dans la base, puis declenche
le workflow.

L'ecriture dans l'agenda revient au script, pour deux raisons. La photo se lit
souvent depuis un telephone, ou aucun `.env` n'est disponible : les
credentials Google sont dans les secrets du repo, donc le sync doit tourner
sur un runner. Et surtout, Claude sans etat qui appellerait l'API Calendar
dupliquerait les evenements a la seconde passe. Le script n'achete pas
l'insertion, il achete l'idempotence.

Le declenchement passe par `workflow_dispatch`, pas par un cron pousse sur
`main` : un cron GitHub peut etre retarde de plusieurs heures (voir les
[reserves sur les crons](../../README.md#planification)), et n'est de toute
facon pas one-shot.

## Deux destinations

| | Jours travailles | Rendez-vous |
|---|---|---|
| Ligne Notion | `Type = Travail` | `Type = RDV` |
| Calendrier | `Planning Aline` (dedie) | perso (config `google.calendars.personal`) |
| Titre | `H1 · 6h30-18h30` | le libelle lu sur le tableau |
| Forme | journee entiere | journee entiere, ou horaire (60 min) si la date Notion porte une heure |

**Les `RDV` ne vont pas dans le calendrier dedie**, mais dans le calendrier
personnel : ce sont des rendez-vous qui contraignent l'agenda d'Adrien, pas des
informations sur le planning d'Aline.

Les horaires ne sont **pas** dans Notion : ils sont codes en dur dans `SHIFTS`.
Le tableau ne porte que les codes, et une base qui repeterait « 6h30-18h30 »
sur treize lignes finirait par se contredire.

## Lecture de la base

Le mois est lu en entier, et **toute incoherence fait echouer le run avant la
moindre ecriture**. Les erreurs sont collectees puis levees d'un bloc : une
lecture de photo qui derape se corrige mieux avec la liste complete qu'avec la
premiere ligne fautive.

Sont refuses : une ligne sans `Date`, un `Type` autre que `Travail` ou `RDV`,
un `Travail` sans `Horaire` ou avec un code inconnu, et **deux jours
travailles sur la meme date**.

La presence d'une heure dans la date Notion est le seul marqueur « evenement
horaire ». Elle n'a de sens que pour un `RDV`.

## Idempotence : le tag, et le sens unique

Le calendrier personnel est tenu a la main : y reconcilier une fenetre de dates
effacerait des saisies manuelles. Chaque evenement ecrit par le script porte
donc un tag dans `extendedProperties.private`
(`planningAlineMonth` + `planningAlineKey`), sur lequel `events.list` sait
filtrer. Le script devient proprietaire d'une fenetre *virtuelle* a
l'interieur du calendrier, ou tout ce qui a ete saisi a la main est
litteralement invisible a la requete.

Le meme mecanisme est applique au calendrier dedie, ou il ne serait pas
necessaire. C'est delibere : le planning est importe une fois par mois puis
retouche **directement dans Google Calendar**, jamais dans Notion. Une
reconciliation par fenetre ecraserait ces retouches au premier re-run venu —
relance d'un run echoue, double declenchement du workflow.

D'ou le regime par defaut, identique des deux cotes : **sens unique**. Le tag
sert uniquement a ne pas creer deux fois. Un evenement deja pose n'est ni
modifie ni supprime, quoi qu'en dise Notion. Relancer le workflow sur un mois
deja importe ne produit donc rien — ni doublon, ni correction.

L'inverse reste accessible par `--reconcile` (input `reconcile` du workflow) :
les evenements tagues sont alignes sur Notion et ceux dont la ligne a disparu
sont supprimes. Il sert a rattraper une photo mal lue — on corrige la base, on
relance en reconciliation. C'est un geste explicite parce qu'il detruit les
retouches manuelles.

La requete des evenements tagues n'a volontairement aucune borne de date : elle
filtre sur le seul tag de mois. Un evenement deplace a la main hors du mois
reste retrouve, et n'est donc pas recree en double.

### Les cles de tag

| Type | Cle | Consequence |
|---|---|---|
| `Travail` | `<mois>:jour:<date>` | un seul jour travaille par date, garanti aussi cote lecture |
| `RDV` | `<mois>:rdv:<libelle slugifie>` | **ne depend pas de la date** |

La cle d'un rdv ignore volontairement la date : un rdv redate a la main reste
reconnu, et un rdv redate dans Notion n'est pas reimporte en double.
Consequence assumee : **deux rdv homonymes dans le meme mois se confondent** —
le second est ignore, et le run le signale (`cle deja prise, ligne ignoree`).

## Rollback

- **Mois importe a tort** : `--reconcile` apres avoir vide les lignes du mois
  dans Notion supprime tous les evenements tagues de ce mois. C'est la seule
  suppression en masse offerte par le script.
- **Photo mal lue** : corriger les lignes Notion, relancer avec `reconcile`.
  Un run par defaut ne corrigera rien.
- **Suppression manuelle** : supprimer les evenements dans Google Calendar.
  Rien dans Notion n'en garde trace, le script n'y ecrit jamais.
- Le script ne touche **jamais** un evenement non tague : les saisies
  manuelles du calendrier perso sont hors de portee, meme en `--reconcile`.

## Le calendrier dedie

`Planning Aline` (id dans `config/instance.json` →
`google.calendars.planningAline`) est cree **a la main** dans l'UI Google
Calendar. Le scope `calendar.events` du refresh token partage permet d'ecrire
des evenements, pas de creer un calendrier ; elargir ce scope en permanence
pour une creation unique ne se justifie pas. Son id vit dans
`config/instance.json`, comme les autres ids de calendriers du repo — ce ne
sont pas des secrets.

## Lancement

Depuis n'importe ou, via le workflow
[`.github/workflows/sync-planning-aline.yml`](../../.github/workflows/sync-planning-aline.yml)
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

Sans `--month` / `month`, le mois courant est calcule dans `Europe/Paris` — pas
dans le fuseau du runner, qui se tromperait de mois le 1er a minuit.

Le `workflow_dispatch` n'apparait dans `gh` qu'une fois le fichier de workflow
present sur `main`.

## Logs

```
gh run list --repo aagwali/scripts-notion --workflow "Sync Planning Aline -> Google Calendar" --limit 5
gh run view <run-id> --repo aagwali/scripts-notion --log
```

Chaque ligne du log porte la date, le jour de la semaine et le titre, pour
relecture humaine — c'est la que se verifie qu'une photo a ete bien lue.

## Limites connues

- **Jamais execute en reel a ce jour.** Toute la chaine est en place et
  testable en `--dry-run`, mais aucun mois n'a encore ete importe.
- **Deux rdv homonymes dans le meme mois se confondent** (voir les cles de
  tag). Le run le signale sans echouer.
- **Un run par defaut ne corrige jamais rien.** C'est la propriete recherchee,
  mais elle surprend : relancer apres avoir corrige Notion ne suffit pas, il
  faut `reconcile`.
- **`--reconcile` detruit les retouches manuelles** faites sur les evenements
  tagues. Ne jamais le proposer sans le dire.
- **Les horaires `H1` / `H2` sont codes en dur.** Un changement d'horaire se
  fait dans le script, pas dans Notion.
- **Un rdv horaire dure toujours 60 minutes** (`APPOINTMENT_MINUTES`), le
  tableau blanc ne portant pas de duree.
- Le script ne remonte rien dans Notion : la base ne sait jamais si un mois a
  ete synchronise, ni quand.
