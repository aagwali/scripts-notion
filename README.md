# email-to-notion

Deux scripts qui alimentent la meme base Notion ("Raw emails") a partir de
deux sources differentes : Gmail (API) et Outlook Pro (export local via
Power Automate / OneDrive). Chaque page Notion cree porte `Status: "To
process"`, consomme ensuite par une tache aval (non incluse ici).

Un troisieme script, sans rapport avec les emails, entretient la base
"Phases" du meme espace Notion : il en sort les phases terminees.

## Prerequis communs

- Node >= 18 (fetch natif)
- `npm install`
- Une integration Notion avec acces a la base "Raw emails"
  (`NOTION_DATABASE_ID` est code en dur dans les deux scripts d'ingestion :
  `ba36c9eb-2587-49e0-abd3-0d47276511c0`), et aux bases "Phases", "Tasks",
  "Docs", "Projects", "Sponsors" et "Phases archivees" pour le script
  d'archivage

## Variables d'environnement

Fichier `.env` local (jamais commite, voir `.gitignore`) :

| Variable | Utilise par | Description |
|---|---|---|
| `NOTION_TOKEN` | les deux | Token d'integration Notion (`secret_xxx` ou `ntn_xxx`) |
| `GOOGLE_CLIENT_ID` | Gmail | Client OAuth Google (type "Desktop app") |
| `GOOGLE_CLIENT_SECRET` | Gmail | Secret du client OAuth |
| `GOOGLE_REFRESH_TOKEN` | Gmail | Genere une fois via `gmail-auth.ts` |

---

## 1. Gmail -> Notion

Fichier : [`email-to-notion-input-gmail.ts`](email-to-notion-input-gmail.ts)

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
   npx tsx gmail-auth.ts
   ```
   Ouvre le navigateur, demande le consentement, ecrit
   `GOOGLE_REFRESH_TOKEN` dans `.env` automatiquement.
   > En mode Testing, ce refresh token expire au bout de 7 jours — relancer
   > `gmail-auth.ts` si le script commence a echouer avec une erreur de
   > rafraichissement.
4. Lancer manuellement pour verifier :
   ```
   npx tsx email-to-notion-input-gmail.ts
   ```

### Planification : GitHub Actions

Workflow : [`.github/workflows/email-to-notion-gmail.yml`](.github/workflows/email-to-notion-gmail.yml)

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
  gh secret set NOTION_TOKEN --repo aagwali/email-to-notion --body "..."
  gh secret set GOOGLE_CLIENT_ID --repo aagwali/email-to-notion --body "..."
  gh secret set GOOGLE_CLIENT_SECRET --repo aagwali/email-to-notion --body "..."
  gh secret set GOOGLE_REFRESH_TOKEN --repo aagwali/email-to-notion --body "..."
  ```
- Le cron GitHub Actions ne se declenche que sur la **branche par
  defaut** (`main`) — pusher ailleurs ne suffit pas.
- Declenchement manuel pour tester :
  ```
  gh workflow run "Email to Notion (Gmail)" --repo aagwali/email-to-notion
  gh run list --repo aagwali/email-to-notion --limit 1
  ```

---

## 2. Outlook -> Notion

Fichier : [`email-to-notion-input-outlook.ts`](email-to-notion-input-outlook.ts)

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
npx tsx email-to-notion-input-outlook.ts
```

### Planification : LaunchAgent local

Ce script depend d'un dossier local (OneDrive monte), donc pas de
GitHub Actions possible — il tourne directement sur la machine via
launchd.

Plist : `~/Library/LaunchAgents/com.agwali.email-to-notion-outlook.plist`
— declenche tous les jours a **3h30 heure locale**.

```
# recharger apres modification du plist
launchctl unload ~/Library/LaunchAgents/com.agwali.email-to-notion-outlook.plist
launchctl load ~/Library/LaunchAgents/com.agwali.email-to-notion-outlook.plist

# forcer un run manuel
launchctl start com.agwali.email-to-notion-outlook

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

Fichier : [`archive-phases.ts`](archive-phases.ts)

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
npx tsx archive-phases.ts --dry-run
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
npx tsx archive-phases.ts --dry-run   # simulation
npx tsx archive-phases.ts             # pour de vrai
```

### Planification : GitHub Actions

Workflow : [`.github/workflows/archive-phases.yml`](.github/workflows/archive-phases.yml)

- Declenchement hebdomadaire, le lundi a `04:00` UTC. Meme reserve que
  pour le workflow Gmail : pas d'ajustement automatique au changement
  d'heure, et les runs planifies peuvent etre retardes.
- Seul secret requis : `NOTION_TOKEN` (deja pose pour le workflow Gmail).
- Declenchement manuel :
  ```
  gh workflow run "Archive Phases (Notion)" --repo aagwali/email-to-notion
  ```

---

## Consulter les logs d'execution

Au-dela du resultat visible dans la base Notion, chaque script a sa propre
trace technique.

### Gmail (GitHub Actions)

- Interface web : [Actions du repo](https://github.com/aagwali/email-to-notion/actions)
  — ouvrir le run du jour, chaque step est depliable avec ses logs complets.
- En CLI :
  ```
  gh run list --repo aagwali/email-to-notion --limit 5
  gh run view <run-id> --repo aagwali/email-to-notion --log
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
  launchctl list | grep email-to-notion
  ```
- Si `logs/outlook.log` est vide ou absent, c'est le signe que launchd n'a
  meme pas declenche le job (ex : machine en veille toute la nuit). Le
  detail se trouve alors dans les logs systeme :
  ```
  log show --predicate 'process == "launchd"' --last 12h | grep email-to-notion-outlook
  ```
  ou via Console.app en filtrant sur `email-to-notion-outlook`.

### Archivage des phases (GitHub Actions)

Meme acces que pour Gmail, workflow `Archive Phases (Notion)`. Le log du
run est la **trace de rollback** : il contient l'id de chaque phase, l'id
de la page archive creee et l'id de chaque Task/Doc reattribuee.

```
gh run list --repo aagwali/email-to-notion --workflow "Archive Phases (Notion)" --limit 5
gh run view <run-id> --repo aagwali/email-to-notion --log
```

Les runs GitHub Actions sont conserves 90 jours. Pour un lot important
(premiere execution, reprise apres incident), lancer plutot le script en
local et garder la sortie :

```
npx tsx archive-phases.ts | tee logs/archive-phases-$(date +%F).log
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
  `npx tsx gmail-auth.ts`.
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
