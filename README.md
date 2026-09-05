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

**Projection vers Google Calendar.** Un script reporte les dates
`Deadline` et `Reminder` de la base "Tasks" dans deux calendriers Google
dedies, et retire de l'agenda ce qui a disparu de Notion.

**Planning d'Aline.** Un dernier script projette vers Google Calendar les
jours travailles de la base "Planning Aline", elle-meme alimentee par une
tache Claude qui lit la photo d'un tableau blanc.

## Arborescence

```
scripts/
  import-gmail.ts      # Gmail -> Notion        (GitHub Actions, quotidien)
  import-outlook.ts    # Outlook -> Notion      (LaunchAgent local, quotidien)
  archive-phases.ts    # entretien base Phases  (GitHub Actions, hebdomadaire)
  reset-recurring-events.ts       # reset base Recurring events (GitHub Actions, quotidien)
  reset-recurring-events.test.ts  # tests de la logique de serie, sans appel Notion
  sync-tasks-calendar.ts          # Tasks -> Google Calendar (GitHub Actions, quotidien)
  sync-planning-aline.ts          # Planning Aline -> Google Calendar (a la demande)
  google-auth.ts       # utilitaire : genere GOOGLE_REFRESH_TOKEN, a lancer une fois
.claude/skills/
  planning-aline/SKILL.md         # la tache Claude qui lit la photo du tableau
.github/workflows/
  import-gmail.yml
  archive-phases.yml
  reset-recurring-events.yml
  sync-tasks-calendar.yml
  sync-planning-aline.yml         # workflow_dispatch uniquement, pas de cron
```

## Planification

Tout tourne de nuit, dans cet ordre (heures de Paris) :

| Heure | Script | Declencheur | Cron |
|---|---|---|---|
| 22h | `import-gmail` | GitHub Actions | `0 20 * * *` UTC |
| 23h | `import-outlook` | LaunchAgent local | `Hour 23` (heure locale) |
| minuit | `reset-recurring-events` | GitHub Actions | `0 22` + `0 23 * * *` UTC |
| 2h | `sync-tasks-calendar` | GitHub Actions | `0 0 * * *` UTC |
| lundi 4h | `archive-phases` | GitHub Actions | `0 2 * * 1` UTC |

Les heures GitHub Actions sont ecrites en UTC et **ne suivent pas le
changement d'heure** : celles du tableau valent pour l'ete (CEST), et
tout glisse d'une heure en hiver. Seul `reset-recurring-events` y echappe,
avec ses deux crons encadrant minuit (voir §4).

L'ordre a surtout une valeur de lisibilite. Les runs planifies GitHub
peuvent etre retardes de plusieurs minutes a plusieurs heures selon la
charge de l'infra : l'etalement ecrit dans les crons n'est pas celui qui
est obtenu, et aucun script ne depend de l'heure de passage d'un autre.

`sync-planning-aline` echappe au tableau : aucun cron, il est declenche a
la main (ou par la skill) quand une nouvelle photo du tableau blanc
arrive (voir §6).

Les tests (`npm test`) ne couvrent que `reset-recurring-events` : c'est le
seul script dont le comportement depend d'un arbitrage de dates invisible
a la relecture.

Tous les scripts lisent `.env` **relativement au repertoire courant** :
les lancer depuis la racine du repo, jamais depuis `scripts/`. Les
raccourcis `npm run` (`import:gmail`, `import:outlook`, `archive-phases`,
`google-auth`, `sync-tasks-calendar`, `sync-planning-aline`) s'en
chargent.

## Prerequis communs

- Node >= 18 (fetch natif)
- `npm install`
- Une integration Notion avec acces a la base "Raw emails"
  (`NOTION_DATABASE_ID` est code en dur dans les deux scripts d'ingestion :
  `ba36c9eb-2587-49e0-abd3-0d47276511c0`), et aux bases "Phases", "Tasks",
  "Docs", "Projects", "Sponsors" et "Phases archivees" pour le script
  d'archivage, a la base "Recurring events" pour le script de reset, et a
  la base "Planning Aline" pour le script de planning
- Un seul client OAuth Google pour Gmail et Calendar : `google-auth.ts`
  demande les deux scopes en une fois

## Variables d'environnement

Fichier `.env` local (jamais commite, voir `.gitignore`) :

| Variable | Utilise par | Description |
|---|---|---|
| `NOTION_TOKEN` | tous | Token d'integration Notion (`secret_xxx` ou `ntn_xxx`) |
| `GOOGLE_CLIENT_ID` | Gmail, Calendar | Client OAuth Google (type "Desktop app") |
| `GOOGLE_CLIENT_SECRET` | Gmail, Calendar | Secret du client OAuth |
| `GOOGLE_REFRESH_TOKEN` | Gmail, Calendar | Genere une fois via `scripts/google-auth.ts`, porte les deux scopes |

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
   npx tsx scripts/google-auth.ts
   ```
   Ouvre le navigateur, demande le consentement, ecrit
   `GOOGLE_REFRESH_TOKEN` dans `.env` automatiquement.
   > En mode Testing, ce refresh token expire au bout de 7 jours — relancer
   > `scripts/google-auth.ts` si le script commence a echouer avec une erreur de
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
— declenche tous les jours a **23h00 heure locale**.

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
suivant, pas a 23h pile. Si le Mac reste ouvert et **branche sur
secteur**, `pmset` est configure ici pour ne jamais dormir automatiquement
sur secteur, donc le job tourne a l'heure, ecran eteint ou non.

L'heure a ete ramenee de 3h30 a 23h justement pour reduire ce risque : a
23h la machine est souvent encore ouverte, alors qu'a 3h30 le capot est
generalement ferme et le job ne partait qu'au reveil du lendemain.

Si ce compromis "best effort" ne convient toujours pas, un reveil
programme regle le cas sans rien reconstruire :

```
sudo pmset repeat wakeorpoweron MTWRFSU 22:55:00
```

(reveille la machine juste avant l'heure du job, meme capot ferme et sur
secteur).

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

- Declenchement hebdomadaire, le lundi a `02:00` UTC (4h a Paris en ete,
  3h en hiver). Meme reserve que
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
| `Recurrence` | select | `Quotidien`, `Hebdo`, `Mensuel`, `Sur demande`, `En pause`, `Externe` |
| `Weekday` | multi-select | `Lun` ... `Dim`, lu uniquement si `Recurrence = Hebdo` |
| `Monthday` | number | Jour du mois 1-31, lu uniquement si `Recurrence = Mensuel` |

- `Quotidien` : traite tous les jours.
- `Hebdo` : traite uniquement les jours coches dans `Weekday`. Plusieurs
  jours sont permis (`Lun` + `Jeu` = deux fois par semaine).
- `Mensuel` : traite uniquement le jour du mois porte par `Monthday`. Un
  `Monthday` au-dela de la fin du mois est **ramene au dernier jour** : un
  evenement cale sur le 31 passe le 28 en fevrier. Le choix est
  delibere — un rappel mensuel doit passer douze fois par an, et sauter
  fevrier creerait un trou silencieux que le gel de `Series` ferait
  ensuite passer pour une panne. Un `Monthday` vide, non entier ou hors de
  1-31 sort en erreur : sans ce garde-fou, l'evenement disparaitrait de la
  vue sans que rien ne le signale.
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

La recherche de l'occurrence attendue remonte jusqu'a **31 jours** : c'est
le pire ecart entre deux occurrences mensuelles (un 31 janvier suivi d'un
28 fevrier ramene). Un `Hebdo` la trouve de toute facon dans les 7
premiers jours.

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

## 5. Tasks -> Google Calendar

Fichier : [`scripts/sync-tasks-calendar.ts`](scripts/sync-tasks-calendar.ts)

Base concernee : "Tasks" (`3438b4b8-8465-80a6-ac08-d30445212e90`).

### Fonctionnement

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

### Le perimetre d'un run, et le piege du troisieme cas

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

### Reprise de l'existant (Make)

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

### Lancement manuel

```
npx tsx scripts/sync-tasks-calendar.ts --dry-run   # simulation, aucun appel d'ecriture
npx tsx scripts/sync-tasks-calendar.ts             # pour de vrai
```

Le `--dry-run` n'appelle pas Google du tout : il montre le perimetre et
l'action retenue pour chaque date.

### Scope Calendar

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

---

## 6. Planning d'Aline -> Google Calendar

Fichier : [`scripts/sync-planning-aline.ts`](scripts/sync-planning-aline.ts)
Tache Claude : [`.claude/skills/planning-aline/SKILL.md`](.claude/skills/planning-aline/SKILL.md)
Base concernee : "Planning Aline" (`8042d9c1-3ea1-481d-a64e-b48d9a138f19`)

Seul flux du repo lance a la demande, sans aucun cron.

### Le besoin

Aline travaille une quinzaine de jours par mois, en deux horaires : `H1`
(6h30-18h30) et `H2` (7h30-19h30). Son planning n'existe que sous une
seule forme, un tableau blanc mensuel a la maison, rempli au feutre. Les
jours ou elle travaille, les trajets scolaires me reviennent : ces
jours-la le teletravail est obligatoire, et cette contrainte doit etre
visible dans mon agenda au moment ou je pose mes rendez-vous.

### La chaine

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
la section Planification), et n'est de toute facon pas one-shot.

### Deux destinations

| | Jours travailles | Rendez-vous |
|---|---|---|
| Ligne Notion | `Type = Travail` | `Type = RDV` |
| Calendrier | `Planning Aline` (dedie) | `adrienagwali@gmail.com` (perso) |
| Titre | `H1 · 6h30-18h30` | le libelle lu sur le tableau |
| Forme | journee entiere | journee entiere, ou horaire si la date Notion porte une heure |

Les horaires ne sont **pas** dans Notion : ils sont codes en dur dans
`SHIFTS`. Le tableau ne porte que les codes, et une base qui repeterait
"6h30-18h30" sur treize lignes finirait par se contredire.

### Idempotence : le tag, et le sens unique

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

### Le calendrier dedie

`Planning Aline`
(`affbc5703ccd88c8fd08e946acf97e75cd87896faea2411eda2c7f31c8971b4e`) est
cree **a la main** dans l'UI Google Calendar. Le scope `calendar.events`
du refresh token partage permet d'ecrire des evenements, pas de creer un
calendrier ; elargir ce scope en permanence pour une creation unique ne
se justifie pas. Son id est code en dur, comme les autres ids de
calendriers du repo — ce ne sont pas des secrets.

### Lancement

Depuis n'importe ou, via le workflow :

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
  `npx tsx scripts/google-auth.ts`. Pour en sortir une bonne fois, voir
  [`docs/oauth-production.md`](docs/oauth-production.md).
- **`Calendar API 403 ... insufficientPermissions`** : le refresh token
  a ete emis avant l'ajout du scope Calendar. Relancer
  `npx tsx scripts/google-auth.ts` (verifier aussi que l'API Google
  Calendar est activee sur le projet Cloud).
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
