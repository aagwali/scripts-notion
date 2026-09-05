# scripts-notion

Scripts d'automatisation autour d'un meme espace Notion, partageant une
seule integration (`NOTION_TOKEN`) et un seul jeu de dependances.

**Ingestion d'emails.** Deux scripts alimentent la base "Raw emails" a
partir de deux sources differentes : Gmail (API) et Outlook Pro (export
local via Power Automate / OneDrive). Chaque page Notion cree porte
`Status: "To process"`, consomme ensuite par une tache aval (non incluse
ici).

**Entretien des bases.** Deux autres scripts, sans rapport avec les
emails, sortent les phases terminees de la base "Phases" et remettent a
zero chaque nuit la base "Recurring events".

## Arborescence

```
scripts/
  import-gmail.ts      # Gmail -> Notion        (GitHub Actions, quotidien)
  import-outlook.ts    # Outlook -> Notion      (LaunchAgent local, quotidien)
  archive-phases.ts    # entretien base Phases  (GitHub Actions, hebdomadaire)
  reset-recurring-events.ts       # reset base Recurring events (GitHub Actions, quotidien)
  reset-recurring-events.test.ts  # tests de la logique de serie, sans appel Notion
  gmail-auth.ts        # utilitaire : genere GOOGLE_REFRESH_TOKEN, a lancer une fois
.github/workflows/
  import-gmail.yml
  archive-phases.yml
  reset-recurring-events.yml
```

Les tests (`npm test`) ne couvrent que `reset-recurring-events` : c'est le
seul script dont le comportement depend d'un arbitrage de dates invisible
a la relecture.

Tous les scripts lisent `.env` **relativement au repertoire courant** :
les lancer depuis la racine du repo, jamais depuis `scripts/`. Les
raccourcis `npm run` (`import:gmail`, `import:outlook`, `archive-phases`,
`gmail-auth`) s'en chargent.

## Prerequis communs

- Node >= 18 (fetch natif)
- `npm install`
- Une integration Notion avec acces a la base "Raw emails"
  (`NOTION_DATABASE_ID` est code en dur dans les deux scripts d'ingestion :
  `ba36c9eb-2587-49e0-abd3-0d47276511c0`), et aux bases "Phases", "Tasks",
  "Docs", "Projects", "Sponsors" et "Phases archivees" pour le script
  d'archivage, et a la base "Recurring events" pour le script de reset

## Variables d'environnement

Fichier `.env` local (jamais commite, voir `.gitignore`) :

| Variable | Utilise par | Description |
|---|---|---|
| `NOTION_TOKEN` | les deux | Token d'integration Notion (`secret_xxx` ou `ntn_xxx`) |
| `GOOGLE_CLIENT_ID` | Gmail | Client OAuth Google (type "Desktop app") |
| `GOOGLE_CLIENT_SECRET` | Gmail | Secret du client OAuth |
| `GOOGLE_REFRESH_TOKEN` | Gmail | Genere une fois via `scripts/gmail-auth.ts` |

---

## 1. Gmail -> Notion

Fichier : [`scripts/import-gmail.ts`](scripts/import-gmail.ts)

### Fonctionnement

- Requete Gmail : messages de la boite de reception (ou non lus hors boite),
  de moins de 2 jours, sans le label `Importe` ni `Traite`.
- Pour chaque message : extraction des en-tetes, aplatissement du corps
  (text/plain prioritaire sur text/html), nettoyage mecanique (citations,
  pixels de tracking, footers de desabonnement...), creation de la page
  Notion, puis pose du label Gmail `Importe`.
- Idempotence : un message deja present en Notion (verifie par `Message
  ID`) est simplement relabellise sans recreer de page — couvre le cas d'un
  run precedent interrompu entre l'ecriture Notion et la pose du label.
- 100 messages max par run.

### Mise en place initiale

1. Dans [console.cloud.google.com](https://console.cloud.google.com) :
   activer l'API Gmail, creer un client OAuth de type **Desktop app**
   (obligatoire pour le flux loopback), ajouter votre compte comme *Test
   user* si l'app est en mode Testing.
2. Renseigner `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` dans `.env`.
3. Lancer une seule fois :
   ```
   npx tsx scripts/gmail-auth.ts
   ```
   Ouvre le navigateur, demande le consentement, ecrit
   `GOOGLE_REFRESH_TOKEN` dans `.env` automatiquement.
   > En mode Testing, ce refresh token expire au bout de 7 jours — relancer
   > `scripts/gmail-auth.ts` si le script commence a echouer avec une erreur de
   > rafraichissement.
4. Lancer manuellement pour verifier :
   ```
   npx tsx scripts/import-gmail.ts
   ```

### Planification : GitHub Actions

Workflow : [`.github/workflows/import-gmail.yml`](.github/workflows/import-gmail.yml)

- Declenchement quotidien a `20:00` UTC (soit 22h heure de Paris en ete,
  21h en hiver). GitHub Actions ne connait que l'UTC : pas d'ajustement
  automatique au changement d'heure, a corriger manuellement dans le
  cron si besoin.
  > A noter : les runs planifies GitHub Actions peuvent etre retardes de
  > plusieurs heures en cas de forte charge sur l'infra GitHub — ce n'est
  > pas garanti a l'heure pile.
- Secrets requis sur le repo (`Settings > Secrets and variables >
  Actions`) : `NOTION_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REFRESH_TOKEN`.
  ```
  gh secret set NOTION_TOKEN --repo aagwali/scripts-notion --body "..."
  gh secret set GOOGLE_CLIENT_ID --repo aagwali/scripts-notion --body "..."
  gh secret set GOOGLE_CLIENT_SECRET --repo aagwali/scripts-notion --body "..."
  gh secret set GOOGLE_REFRESH_TOKEN --repo aagwali/scripts-notion --body "..."
  ```
- Le cron GitHub Actions ne se declenche que sur la **branche par
  defaut** (`main`) — pusher ailleurs ne suffit pas.
- Declenchement manuel pour tester :
  ```
  gh workflow run "Import Gmail (Notion)" --repo aagwali/scripts-notion
  gh run list --repo aagwali/scripts-notion --limit 1
  ```

---

## 2. Outlook -> Notion

Fichier : [`scripts/import-outlook.ts`](scripts/import-outlook.ts)

### Fonctionnement

Outlook Pro n'expose rien via l'API (pas d'URL de message, pas de labels,
pas de `List-Unsubscribe`). Un flux Power Automate depose donc un fichier
texte par email dans un dossier OneDrive local :

```
/Users/a.agwali/Library/CloudStorage/OneDrive-Reply/emails/inbound/
```

En-tetes attendus en tete de fichier, suivis d'une ligne vide :
```
De: ...
Objet: ...
Reçu: ...
Message ID: @{triggerOutputs()?['body/internetMessageId']}
Thread ID: @{triggerOutputs()?['body/conversationId']}
```

Le script lit chaque fichier, cree la page Notion correspondante
(`Source: "Reply"`), puis deplace le fichier vers
`.../emails/archive/`. Idempotence assuree comme pour Gmail (controle par
`Message ID` avant creation).

### Lancement manuel

```
npx tsx scripts/import-outlook.ts
```

### Planification : LaunchAgent local

Ce script depend d'un dossier local (OneDrive monte), donc pas de
GitHub Actions possible — il tourne directement sur la machine via
launchd.

Plist : `~/Library/LaunchAgents/com.agwali.scripts-notion-outlook.plist`
— declenche tous les jours a **3h30 heure locale**.

```
# recharger apres modification du plist
launchctl unload ~/Library/LaunchAgents/com.agwali.scripts-notion-outlook.plist
launchctl load ~/Library/LaunchAgents/com.agwali.scripts-notion-outlook.plist

# forcer un run manuel
launchctl start com.agwali.scripts-notion-outlook

# logs
cat logs/outlook.log
```

**A propos de la veille** : un ecran verrouille n'empeche pas le job de
se lancer (la session reste active). En revanche, fermer le capot met
*toute la machine* en veille — le job ne se declenche alors qu'au reveil
suivant, pas a 3h30 pile. Si le Mac reste ouvert et **branche sur
secteur**, `pmset` est configure ici pour ne jamais dormir automatiquement
sur secteur, donc le job tourne a l'heure, ecran eteint ou non.

Si ce compromis "best effort" ne convient pas, deux alternatives sans
rien reconstruire :
- **Reveil programme** : `sudo pmset repeat wakeorpoweron MTWRFSU
  03:25:00` (reveille la machine juste avant l'heure du job, meme capot
  ferme et sur secteur).
- **Bascule sur 17h** : changer `Hour`/`Minute` dans le plist puis
  recharger — a cette heure la machine est presque surement deja active.

---

## 3. Archivage des phases terminees

Fichier : [`scripts/archive-phases.ts`](scripts/archive-phases.ts)

### Le probleme

Le selecteur de la relation `Phase` sur Tasks et Docs liste toute la base
"Phases" — Notion n'offre aucun filtre sur un selecteur de relation. Au
bout de quelques dizaines de phases, choisir devient penible. La seule
facon de reduire la liste est de sortir les phases terminees de la base.

Mais une relation Notion est liee a **une seule** data source : on ne peut
pas faire pointer `Tasks.Phase` vers une page d'une autre base, ni deplacer
une page d'une base a une autre. Le lien est donc reporte sur une **seconde
relation**, `Phase archivée`, pointant vers la base archive.

### La base "Phases archivees"

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
compris — ce sont des cles d'API. Sens unique pour `Project`/`Sponsor`
afin de ne pas ajouter de colonne a ces deux bases.

A noter : la limite "1 page" des relations `Project` / `Sponsor` n'est pas
exposee par l'API, elle se pose a la main dans l'UI. Sans importance, le
script n'ecrit jamais plus d'une page.

Les six bases concernees (Phases, Tasks, Docs, Projects, Sponsors, Phases
archivees) doivent etre partagees avec l'integration Notion, ainsi que la
page parente `Databases`.

Avant tout run reel, verifier a blanc — aucune ecriture :

```
npx tsx scripts/archive-phases.ts --dry-run
```

### Fonctionnement

Pour chaque phase dont le `Status` vaut `Done` ou `Cancelled`, dans cet
ordre strict :

1. **Creer** la page archive (ou reprendre celle d'un run interrompu,
   retrouvee par `Phase source ID`).
2. **Reattribuer** chaque Task et chaque Doc liee — requete inverse sur
   `Phase contains <id>`, pas via `Phases.Tasks` qui plafonne a 25
   elements. Un seul PATCH par page : `Phase archivée` prend l'archive,
   `Phase` est videe.
3. **Verifier** en relisant la page : le nouveau lien est present et
   l'ancien est vide.
4. **Corbeille** de la phase d'origine, uniquement si toutes les
   verifications sont passees.

Une seule reattribution en echec suffit a conserver la phase : le script
logue l'etat incomplet, la liste des pages concernees et la commande de
rollback, puis passe a la phase suivante. Le run suivant reprend le
travail sans rien recreer.

Sortie non nulle si au moins une phase est incomplete ou en echec — le
run GitHub Actions apparait alors en rouge.

### `Phase source ID` et fenetre de rollback

`Phase source ID` est une propriete **texte**, pas une relation : elle
contient l'uuid de la phase d'origine sous forme de chaine. Rien ne peut
donc "casser" dessous quand l'original disparait. Elle a deux roles.

**Idempotence.** Avant toute creation, le script cherche dans la base
archive une page dont `Phase source ID` vaut l'id de la phase. S'il en
trouve une, il la reprend au lieu d'en creer une seconde. La comparaison
est chaine a chaine dans la base archive : le script ne va jamais lire la
page source, ce garde-fou fonctionne donc meme une fois l'original detruit.

En pratique il n'est sollicite que dans la fenetre entre "archive creee" et
"phase mise a la corbeille", c'est-a-dire apres un run interrompu — une
phase en corbeille ne remonte plus dans la requete `Status = Done`. Avec
une exception, a l'intersection des deux roles : **si une phase est
restauree depuis la corbeille**, elle redevient `Done` et visible, et c'est
`Phase source ID` qui evite alors de creer une seconde page archive.

**Tracabilite.** L'id relie une page archive a sa ligne de log et a la page
en corbeille (`https://app.notion.com/p/<id sans tirets>`). Il distingue
aussi formellement deux archives homonymes — le cas s'est deja produit avec
deux phases "Mise en place".

**Duree de vie.** Notion conserve une page en corbeille **30 jours** avant
suppression definitive. C'est la vraie fenetre de rollback, et elle porte
sur les phases, pas sur l'identifiant. Passe ce delai il n'y a plus rien a
restaurer : les deux roles operationnels s'eteignent, l'id ne subsiste que
comme empreinte de provenance. Rien n'est perdu pour autant, la page
archive etant une copie complete et non un pointeur. Autant masquer cette
propriete dans les vues de la base : elle est technique.

### Ce qui n'est pas copie

Le script copie les **proprietes** d'une phase, pas le **corps** de sa page
— la zone de saisie libre sous les proprietes. Sans consequence dans cet
usage : les phases servent de point de rattachement, les 14 phases
existantes au moment de la mise en place n'avaient aucun bloc de contenu.

Si cet usage evolue et que des notes sont saisies dans le corps d'une
phase, elles partiraient a la corbeille avec l'original et disparaitraient
a 30 jours. Il faudra alors soit recopier les blocs, soit refuser
d'archiver une phase dont le corps n'est pas vide.

### Lancement manuel

```
npx tsx scripts/archive-phases.ts --dry-run   # simulation
npx tsx scripts/archive-phases.ts             # pour de vrai
```

### Planification : GitHub Actions

Workflow : [`.github/workflows/archive-phases.yml`](.github/workflows/archive-phases.yml)

- Declenchement hebdomadaire, le lundi a `04:00` UTC. Meme reserve que
  pour le workflow Gmail : pas d'ajustement automatique au changement
  d'heure, et les runs planifies peuvent etre retardes.
- Seul secret requis : `NOTION_TOKEN` (deja pose pour le workflow Gmail).
- Declenchement manuel :
  ```
  gh workflow run "Archive Phases (Notion)" --repo aagwali/scripts-notion
  ```

---

## 4. Reset des evenements recurrents

Fichier : [`scripts/reset-recurring-events.ts`](scripts/reset-recurring-events.ts)

Base concernee : "Recurring events" (`3448b4b8-8465-8052-8152-e45a5b833c0e`),
un flux independant de la base Tasks.

### Fonctionnement

A minuit, les evenements programmes ce jour-la sont reamorces pour la
journee qui commence : `Done` decoche, `Date` au jour courant. La vue
"Daily" filtre sur (`Date` = aujourd'hui ET `Done` = false), donc cette
seule ecriture compose la liste du jour, et un evenement non programme
aujourd'hui en disparait de lui-meme.

`Series` compte les occurrences consecutives reussies. Le run arbitre la
journee qui vient de s'ecouler : le `Done` qu'il lit est le clic de
l'occurrence precedente, jamais celui du jour qui commence.

### Les proprietes qui pilotent le script

Deux proprietes ont ete ajoutees a la base. Les noms restent en anglais
comme le reste du schema ; les valeurs sont en francais, comme celles de
`Target session`.

| Propriete | Type | Role |
|---|---|---|
| `Recurrence` | select | `Quotidien`, `Hebdo`, `Sur demande`, `En pause`, `Externe` |
| `Weekday` | multi-select | `Lun` ... `Dim`, lu uniquement si `Recurrence = Hebdo` |

- `Quotidien` : traite tous les jours.
- `Hebdo` : traite uniquement les jours coches dans `Weekday`. Plusieurs
  jours sont permis (`Lun` + `Jeu` = deux fois par semaine).
- `Sur demande` : jamais traite. C'est le cas de "Revue de code",
  declenchee a la main.
- `En pause` : jamais traite, gele en l'etat. C'est le cas de "Rubix
  training".
- `Externe` : jamais traite, parce qu'un autre processus fait deja le reset
  de cette page. C'est le cas de "Revue", reinitialisee par un run Claude.
  Deux resets sur la meme page se marcheraient dessus : celui qui passe en
  premier pose `Date` au jour courant, et l'autre conclut « deja traite »
  sans arbitrer `Series`.
- Vide : jamais traite, mais **signale dans le log et le run sort en
  erreur** — un evenement sans `Recurrence` est une erreur de saisie, pas
  un choix.

Le tag `Sur demande` de la propriete `Tags` portait ce role auparavant.
Il decrivait la nature d'une tache, pas une regle de planification, et ne
savait pas exprimer "hebdo le mardi" : `Tags` redevient purement metier et
n'est plus lu par aucun script.

### Arbitrage de `Series`

Le script se fie a `Date` pour savoir a quelle occurrence le `Done` qu'il
lit se rapporte.

| `Date` lue | Verdict |
|---|---|
| = aujourd'hui | Deja passe aujourd'hui, page laissee intacte |
| = occurrence attendue | Cas nominal : `Done` ? `Series + 1` : `0` |
| plus ancienne | Un run de minuit a saute : `Series` **gelee** |
| vide | Premiere prise en charge : `Series = 0` |
| dans le futur | Signalee, jamais ecrasee |

Le gel merite un mot. Si le run du jeudi ne part pas, la journee du jeudi
n'est jamais affichee dans la vue (`Date` est restee a mercredi) : elle
n'a donc pu etre ni reussie ni echouee. Par ailleurs le `Done` encore
coche est celui de mercredi, deja arbitre par le run du mercredi. Ni
incrementer ni remettre a zero : une panne d'infrastructure ne casse pas
une serie, et ne peut pas non plus la gonfler.

Le premier cas du tableau (`Date` = aujourd'hui) rend le script rejouable :
deux runs le meme jour ne comptent qu'une fois. C'est ce dont depend le
double cron ci-dessous.

### Lancement manuel

```
npx tsx scripts/reset-recurring-events.ts --dry-run   # simulation
npx tsx scripts/reset-recurring-events.ts             # pour de vrai
npm test                                              # tests de la logique
```

Attention : un lancement manuel en pleine journee decoche les `Done` deja
cliques et avance `Date`. Le run de minuit suivant verra `Date` = aujourd'hui
et ne fera rien, donc la journee est perdue pour la serie.

### Planification : GitHub Actions

Workflow : [`.github/workflows/reset-recurring-events.yml`](.github/workflows/reset-recurring-events.yml)

Deux crons quotidiens, `22:00` et `23:00` UTC. Contrairement aux deux
autres workflows, celui-ci **ne demande aucune retouche au changement
d'heure** : `22:00` UTC vaut minuit a Paris en ete, `23:00` UTC vaut minuit
a Paris en hiver, et celui des deux qui tombe du mauvais cote voit `Date`
deja au jour courant et ne touche a rien. Le doublon sert aussi de reprise
si l'un des deux echoue.

Le jour de reference est calcule dans `Europe/Paris`, pas dans le fuseau du
runner : un runner GitHub est en UTC et se tromperait d'un jour a minuit.

- Seul secret requis : `NOTION_TOKEN` (deja pose pour les autres workflows).
- Declenchement manuel :
  ```
  gh workflow run "Reset Recurring Events (Notion)" --repo aagwali/scripts-notion
  ```

---

## Consulter les logs d'execution

Au-dela du resultat visible dans la base Notion, chaque script a sa propre
trace technique.

### Gmail (GitHub Actions)

- Interface web : [Actions du repo](https://github.com/aagwali/scripts-notion/actions)
  — ouvrir le run du jour, chaque step est depliable avec ses logs complets.
- En CLI :
  ```
  gh run list --repo aagwali/scripts-notion --limit 5
  gh run view <run-id> --repo aagwali/scripts-notion --log
  ```
- Un seul run attendu chaque nuit, autour de `20:00` UTC — mais l'heure
  reelle de declenchement peut varier (voir remarque sur les delais plus
  haut).

### Outlook (LaunchAgent)

- Fichier de log (stdout + stderr combines) :
  ```
  cat logs/outlook.log
  ```
  Contient soit `Aucun fichier a traiter.`, soit le detail des imports
  (`- fichier.txt` / `ok -> Notion + archive`), soit un message d'echec.
- Code de sortie du dernier run (0 = OK) :
  ```
  launchctl list | grep scripts-notion
  ```
- Si `logs/outlook.log` est vide ou absent, c'est le signe que launchd n'a
  meme pas declenche le job (ex : machine en veille toute la nuit). Le
  detail se trouve alors dans les logs systeme :
  ```
  log show --predicate 'process == "launchd"' --last 12h | grep scripts-notion-outlook
  ```
  ou via Console.app en filtrant sur `scripts-notion-outlook`.

### Archivage des phases (GitHub Actions)

Meme acces que pour Gmail, workflow `Archive Phases (Notion)`. Le log du
run est la **trace de rollback** : il contient l'id de chaque phase, l'id
de la page archive creee et l'id de chaque Task/Doc reattribuee.

```
gh run list --repo aagwali/scripts-notion --workflow "Archive Phases (Notion)" --limit 5
gh run view <run-id> --repo aagwali/scripts-notion --log
```

### Reset des evenements recurrents (GitHub Actions)

Meme acces, workflow `Reset Recurring Events (Notion)`. Le log donne, pour
chaque evenement, le verdict retenu et sa raison — c'est la ou lire
pourquoi une serie est repartie de zero ou a ete gelee.

```
gh run list --repo aagwali/scripts-notion --workflow "Reset Recurring Events (Notion)" --limit 5
gh run view <run-id> --repo aagwali/scripts-notion --log
```

Le workflow sort en erreur si un evenement n'a pas de `Recurrence`, ou si
une ecriture Notion echoue.

Les runs GitHub Actions sont conserves 90 jours. Pour un lot important
(premiere execution, reprise apres incident), lancer plutot le script en
local et garder la sortie :

```
npx tsx scripts/archive-phases.ts | tee logs/archive-phases-$(date +%F).log
```

---

## Depannage

- **`Variables d'environnement manquantes`** (Gmail) : verifier `.env` —
  attention au format, `client id : xxx` n'est PAS une syntaxe valide, il
  faut `GOOGLE_CLIENT_ID=xxx`.
- **`command not found: npx` dans les logs du LaunchAgent** : launchd
  n'herite pas du PATH du shell interactif (nvm charge via `.zshrc` n'est
  pas source en mode non-interactif). Le plist source `nvm.sh`
  explicitement avant d'appeler `npx` — si `node`/`nvm` ont ete
  reinstalles ou deplaces, adapter la commande dans le plist.
- **Rafraichissement Google refuse** : si l'app OAuth est en mode
  Testing, le refresh token expire au bout de 7 jours — relancer
  `npx tsx scripts/gmail-auth.ts`.
- **Plist invalide (`plutil -lint` echoue)** : les caracteres `&`, `<`,
  `>` doivent etre echappes en XML (`&amp;`, `&lt;`, `&gt;`) dans les
  `ProgramArguments`.
- **`Notion API 404` sur Phases / Tasks / Docs** : l'integration n'a pas
  acces a la base. Un 404 Notion signifie "invisible pour ce token", pas
  "inexistant" — partager la base depuis son menu `...` > `Connexions`.
- **`Notion API 400 ... is not a property that exists`** (archivage) : un
  nom de propriete ne correspond pas. Verifier `Phase archivée` (avec
  l'accent) sur Tasks et Docs, et `Phase source ID` sur la base archive.
- **Phase restee en place avec `INCOMPLET` dans les logs** : c'est le
  comportement voulu, jamais de suppression apres une reattribution
  partielle. Corriger la cause (souvent un acces manquant) et relancer :
  le run reprend la phase sans recreer sa page archive.
