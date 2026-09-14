# Reset des evenements recurrents

| | |
|---|---|
| Script | [`scripts/reset-recurring-events.ts`](../../scripts/reset-recurring-events.ts) |
| Tests | [`scripts/reset-recurring-events.test.ts`](../../scripts/reset-recurring-events.test.ts) — `npm test` |
| Declencheur | GitHub Actions, quotidien `0 0 * * *` UTC |
| Secrets | `NOTION_TOKEN` |
| Lit / ecrit | base Notion "Recurring events" (`3448b4b8-8465-8052-8152-e45a5b833c0e`) |
| Calendriers Google | aucun |

Un flux independant de la base Tasks.

## Fonctionnement

A chaque passage de minuit, les evenements programmes ce jour-la sont reamorces
pour la journee qui commence : `Done` decoche, `Date` au jour courant. La vue
"Daily" de la base filtre sur (`Date` = aujourd'hui ET `Done` = false), donc
cette seule ecriture compose la liste du jour, et un evenement non programme
aujourd'hui en disparait de lui-meme.

`Series` compte les occurrences consecutives reussies. Le run arbitre la
journee qui vient de s'ecouler : le `Done` qu'il lit est le clic de
l'occurrence precedente, jamais celui du jour qui commence.

La base tient en quelques dizaines de lignes : elle est lue entierement plutot
que filtree cote Notion, pour pouvoir tracer dans le log pourquoi chaque
evenement a ete ecarte.

## Les proprietes qui pilotent le script

Les noms restent en anglais comme le reste du schema ; les valeurs sont en
francais, comme celles de `Target session`.

| Propriete | Type | Role |
|---|---|---|
| `Recurrence` | select | `Quotidien`, `Hebdo`, `Mensuel`, `Sur demande`, `En pause`, `Externe` |
| `Weekday` | multi-select | `Lun` ... `Dim`, lu uniquement si `Recurrence = Hebdo` |
| `Monthday` | number | Jour du mois 1-31, lu uniquement si `Recurrence = Mensuel` |
| `Done` | checkbox | lu (occurrence precedente), puis remis a `false` |
| `Series` | number | ecrit |
| `Date` | date | lu (occurrence precedente), puis pose au jour courant |

- `Quotidien` : traite tous les jours.
- `Hebdo` : traite uniquement les jours coches dans `Weekday`. Plusieurs jours
  sont permis (`Lun` + `Jeu` = deux fois par semaine).
- `Mensuel` : traite uniquement le jour du mois porte par `Monthday`. Un
  `Monthday` au-dela de la fin du mois est **ramene au dernier jour** : un
  evenement cale sur le 31 passe le 28 en fevrier. Le choix est delibere — un
  rappel mensuel doit passer douze fois par an, et sauter fevrier creerait un
  trou silencieux que le gel de `Series` ferait ensuite passer pour une panne.
  Un `Monthday` vide, non entier ou hors de 1-31 sort en erreur : sans ce
  garde-fou, l'evenement disparaitrait de la vue sans que rien ne le signale.
- `Sur demande` : jamais traite. C'est le cas de « Revue de code », declenchee
  a la main.
- `En pause` : jamais traite, gele en l'etat. C'est le cas de « Rubix
  training ».
- `Externe` : jamais traite, parce qu'un autre processus fait deja le reset de
  cette page. C'est le cas de « Revue », reinitialisee par un run Claude. Deux
  resets sur la meme page se marcheraient dessus : celui qui passe en premier
  pose `Date` au jour courant, et l'autre conclut « deja traite » sans
  arbitrer `Series`.
- Vide : jamais traite, mais **signale dans le log et le run sort en erreur** —
  un evenement sans `Recurrence` est une erreur de saisie, pas un choix.

Le tag `Sur demande` de la propriete `Tags` portait ce role auparavant. Il
decrivait la nature d'une tache, pas une regle de planification, et ne savait
pas exprimer « hebdo le mardi » : `Tags` redevient purement metier et n'est
plus lu par aucun script.

## Arbitrage de `Series`

Le script se fie a `Date` pour savoir a quelle occurrence le `Done` qu'il lit
se rapporte.

| `Date` lue | Verdict |
|---|---|
| = aujourd'hui | Deja passe aujourd'hui, page laissee intacte |
| = occurrence attendue | Cas nominal : `Done` ? `Series + 1` : `0` |
| plus ancienne | Un run de minuit a saute : `Series` **gelee** |
| vide | Premiere prise en charge : `Series = 0` |
| dans le futur | Signalee, jamais ecrasee |

La recherche de l'occurrence attendue remonte jusqu'a **31 jours** : c'est le
pire ecart entre deux occurrences mensuelles (un 31 janvier suivi d'un 28
fevrier ramene). Un `Hebdo` la trouve de toute facon dans les 7 premiers jours.

Le gel merite un mot. Si le run du jeudi ne part pas, la journee du jeudi n'est
jamais affichee dans la vue (`Date` est restee a mercredi) : elle n'a donc pu
etre ni reussie ni echouee. Par ailleurs le `Done` encore coche est celui de
mercredi, deja arbitre par le run du mercredi. Ni incrementer ni remettre a
zero : une panne d'infrastructure ne casse pas une serie, et ne peut pas non
plus la gonfler.

## Idempotence et rejeu

Le premier cas du tableau (`Date` = aujourd'hui) rend le script **rejouable** :
deux runs le meme jour ne comptent qu'une fois, le second laisse chaque page
intacte.

C'est ce dont depend la coexistence du cron et d'un `workflow_dispatch`
manuel. Le workflow porte en plus un groupe `concurrency` (sans annulation) :
la rejouabilite repose sur une lecture puis une ecriture de `Date`, que deux
runs **simultanes** pourraient enjamber.

En cas d'echec d'ecriture sur une page, celle-ci reste en l'etat — `Date`
inchangee. Le prochain run la verra donc comme un trou et gelera sa `Series`
plutot que de la fausser.

**Attention : un lancement manuel en pleine journee n'est pas neutre.** Il
decoche les `Done` deja cliques et avance `Date`. Le run de minuit suivant
verra `Date` = aujourd'hui et ne fera rien : la journee est perdue pour la
serie.

## Rollback

Aucune procedure automatique. Le script ne supprime ni ne cree de page, il
ecrit trois proprietes sur des pages existantes.

Le log donne, pour chaque evenement, l'ancienne et la nouvelle valeur de
`Series` (`Series 4 -> 5`), ainsi que le verdict et sa raison. C'est la trace
de rollback : remettre a la main la valeur d'origine sur les pages concernees,
et recorriger `Date` si le run a ete lance par erreur en pleine journee.

## Lancement manuel

```
npx tsx scripts/reset-recurring-events.ts --dry-run   # simulation
npx tsx scripts/reset-recurring-events.ts             # pour de vrai
npm test                                              # tests de la logique
```

C'est le seul script couvert par `npm test` : le seul dont le comportement
depend d'un arbitrage de dates invisible a la relecture. Les 40 cas couvrent
`decide()`, `previousOccurrence()`, `isMonthdayOn()`, `addDays()` et
`weekdayOf()`, y compris les changements d'heure et les annees bissextiles.
Les tests ne font **aucun appel Notion**.

## Planification : GitHub Actions

Workflow : [`.github/workflows/reset-recurring-events.yml`](../../.github/workflows/reset-recurring-events.yml)

- Un cron quotidien, `0 0 * * *` UTC — soit 1h ou 2h a Paris selon l'heure
  d'ete ou d'hiver. **Sans enjeu ici**, contrairement aux autres workflows :
  seul le jour calendaire compte pour ce script, et il est calcule dans
  `Europe/Paris`, pas dans le fuseau du runner (un runner GitHub est en UTC et
  se tromperait d'un jour a minuit).
- Groupe `concurrency: reset-recurring-events`, sans `cancel-in-progress` :
  empeche un cron et un lancement manuel de se chevaucher.
- Declenchement manuel :
  ```
  gh workflow run "Reset Recurring Events (Notion)" --repo aagwali/scripts-notion
  ```

## Logs

Le log donne, pour chaque evenement, le verdict retenu et sa raison — c'est la
ou lire pourquoi une serie est repartie de zero ou a ete gelee.

```
gh run list --repo aagwali/scripts-notion --workflow "Reset Recurring Events (Notion)" --limit 5
gh run view <run-id> --repo aagwali/scripts-notion --log
```

Le workflow sort en erreur si un evenement n'a pas de `Recurrence`, ou si une
ecriture Notion echoue.

## Limites connues

- **Un lancement manuel en journee coute une occurrence** (voir plus haut).
- **Pas de rattrapage des journees manquees** : une serie gelee reste gelee,
  la journee sautee n'est jamais proposee.
- **Le script ne cree jamais de page** : une serie absente de la base
  n'apparait pas toute seule.
- **`Recurrence = Externe` n'est pas verifiee** : le script fait confiance au
  fait qu'un autre processus s'en occupe. Si ce processus s'arrete, la page
  n'est plus jamais reamorcee et rien ne le signale.
- Le script lit toute la base a chaque run. Sans consequence aux volumes
  actuels (quelques dizaines de lignes).
