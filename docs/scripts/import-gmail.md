# Gmail -> Notion

| | |
|---|---|
| Script | [`scripts/import-gmail.ts`](../../scripts/import-gmail.ts) |
| Declencheur | GitHub Actions, quotidien `0 20 * * *` UTC (22h a Paris en ete) |
| Secrets | `NOTION_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
| Lit | Gmail (API), scope `gmail.modify` |
| Ecrit | base Notion "Raw inputs" (config `notion.databases.rawInputs`), label Gmail `Importé` |
| Calendriers Google | aucun |

## Role

Alimente la base "Raw inputs" depuis la boite Gmail personnelle. Chaque page
creee porte `Status = "To process"`. Le script ne fait que du factuel :
extraction d'en-tetes, aplatissement du corps, nettoyage mecanique. Aucune
classification, aucun resume — c'est le travail du consommateur en aval.

Ce consommateur est une tache planifiee claude.ai, dont le mode operatoire vit
sur Notion : [Run quotidien email](https://app.notion.com/p/3cd8b4b88465815eb7bff0b74c7ad4ba).
Ne pas en recopier le contenu ici. Deux points de ce doc contraignent
directement ce script, et sont donc rappeles plus bas : la resolution de
l'identifiant Gmail (§3.1) et le cycle d'idempotence (§8).

## Fonctionnement

- Requete Gmail : messages de la boite de reception (ou non lus hors boite),
  de moins de 2 jours, sans le label `Importé` ni `Traité`.
- Pour chaque message : extraction des en-tetes, aplatissement du corps
  (text/plain prioritaire sur text/html), nettoyage mecanique (citations,
  pixels de tracking, footers de desabonnement...), creation de la page
  Notion, puis pose du label Gmail `Importé`.
- 100 messages max par run.

Le bornage a 2 jours vaut aussi pour le premier run : au-dela, un mail non
importe releve de l'incident, pas du fonctionnement nominal.

## Ce qui est ecrit dans "Raw inputs"

| Propriete Notion | Source |
|---|---|
| `Name` | en-tete `Subject`, ou `(sans objet)` |
| `From` | en-tete `From` |
| `Body` | corps aplati puis nettoye |
| `Received` | en-tete `Date`, repli sur `internalDate` si illisible |
| `Message ID` | en-tete `Message-ID` (RFC 5322) — **fait foi** |
| `Thread ID` | `threadId` Gmail |
| `Gmail message ID` | id interne du message Gmail |
| `Gmail URL` | `https://mail.google.com/mail/u/0/#all/<threadId>`, omise si vide |
| `Unsubscribe URL` | en-tete `List-Unsubscribe`, https prioritaire sur mailto, omise si vide |
| `Labels` | noms des labels Gmail, virgules remplacees par des espaces |
| `Source` | `Perso`, en dur |
| `Channel` | `Email`, en dur |
| `Status` | `To process`, en dur |

**`Gmail message ID` n'est pas un doublon de `Message ID`.** Les deux sont
ecrits et les deux servent. `Message ID` est l'identifiant RFC 5322 et sert de
cle de deduplication a ce script. `Gmail message ID` est l'id interne attendu
par les outils Gmail : c'est la voie nominale de la tache aval (§3.1 du Run
quotidien email) pour muter le message. Sans lui, cette tache retombe sur un
`search_threads rfc822msgid:` — un appel Gmail de plus par item.

Les valeurs texte sont decoupees en objets `rich_text` de 2000 caracteres,
100 au maximum par propriete (~200 000 caracteres) ; au-dela le corps est
tronque avec la mention `[...tronque]`.

## Idempotence et rejeu

Le cycle complet, ce script et sa tache aval :

```
ingestion  ->  Importé (Gmail) + To process (Notion)
tache aval ->  Traité (Gmail)  + Processed (Notion)
```

Le label `Importé` porte la deduplication cote source : un message deja
importe sort du perimetre de la requete. Il est pose **apres** l'ecriture
Notion, jamais avant — il signifie « present en base ».

Reste la fenetre entre les deux ecritures. Elle est couverte par un controle
d'existence sur `Message ID` avant chaque creation : un message deja en base
est simplement relabellise, sans recreer de page. Un run interrompu entre
l'ecriture Notion et la pose du label est donc rattrape au run suivant.

**Rejouer le script est sans effet de bord.** Un message deja traite est soit
hors perimetre (label pose), soit reconnu en base (controle `Message ID`).

Un echec sur un message ne pose pas le label : il repassera au run suivant.
Un echec ne bloque jamais les autres messages du lot.

## Rollback

Aucune procedure automatique — le script ne supprime rien et ne modifie aucun
email, il ajoute un label.

- **Annuler un import** : mettre la page "Raw inputs" a la corbeille Notion
  (restaurable 30 jours) et retirer le label `Importé` du message dans Gmail.
  Sans ce retrait, le message ne sera jamais reimporte.
- **Reimporter tout un lot** : retirer `Importé` des messages concernes. Le
  controle `Message ID` empechera les doublons si les pages Notion sont
  toujours la.
- Gmail reste la source de verite : une ligne "Raw inputs" perdue ne perd pas
  l'email, elle perd son traitement automatique.

## Lancement manuel

```
npx tsx scripts/import-gmail.ts
```

Prerequis : le client OAuth Google et `GOOGLE_REFRESH_TOKEN` doivent etre en
place — voir [`google-auth.md`](google-auth.md) et
[Prerequis communs](../../README.md#prerequis-communs).

Ce script n'a **pas** de `--dry-run`.

## Planification : GitHub Actions

Workflow : [`.github/workflows/import-gmail.yml`](../../.github/workflows/import-gmail.yml)

- Declenchement quotidien a `20:00` UTC (22h a Paris en ete). Voir les
  [reserves sur les crons](../../README.md#planification) : UTC fige et runs
  potentiellement retardes.
- C'est ce workflow qui a pose les quatre secrets en premier, les autres les
  reutilisent :
  ```
  gh secret set NOTION_TOKEN --repo aagwali/scripts-notion --body "..."
  gh secret set GOOGLE_CLIENT_ID --repo aagwali/scripts-notion --body "..."
  gh secret set GOOGLE_CLIENT_SECRET --repo aagwali/scripts-notion --body "..."
  gh secret set GOOGLE_REFRESH_TOKEN --repo aagwali/scripts-notion --body "..."
  ```
- Le cron GitHub Actions ne se declenche que sur la **branche par defaut**
  (`main`) — pusher ailleurs ne suffit pas.
- Declenchement manuel :
  ```
  gh workflow run "Import Gmail (Notion)" --repo aagwali/scripts-notion
  gh run list --repo aagwali/scripts-notion --limit 1
  ```

## Logs

- Interface web : [Actions du repo](https://github.com/aagwali/scripts-notion/actions)
  — ouvrir le run du jour, chaque step est depliable avec ses logs complets.
- En CLI :
  ```
  gh run list --repo aagwali/scripts-notion --limit 5
  gh run view <run-id> --repo aagwali/scripts-notion --log
  ```
- Un seul run attendu chaque nuit, autour de `20:00` UTC — l'heure reelle de
  declenchement peut varier.

## Limites connues

- **Le nettoyage du corps est volontairement conservateur.** Mieux vaut
  laisser du bruit que rogner du contenu utile a la tache aval. Les patterns
  n'utilisent jamais DOTALL sur une ligne de signature, sinon la suite du
  message est avalee.
- **Les virgules sont interdites dans une option multi-select Notion** : elles
  sont remplacees par des espaces dans `Labels`. Un label Gmail contenant une
  virgule n'aura donc pas exactement le meme nom dans Notion.
- **100 messages par run**, sans pagination. Un arriere plus gros ne se
  rattrape pas en un run — mais la requete borne de toute facon a 2 jours.
- **Pas de retry ni de throttle Notion** dans ce script, contrairement aux
  scripts d'entretien : le volume est faible et le travail est par message,
  donc un echec isole est repris au run suivant plutot que retente.
- **La suppression des proprietes `Gmail message ID` ou `Channel`** ferait
  echouer toute creation de page : Notion rejette une propriete inconnue dans
  le payload. Les deux sont ecrites ici et lues par la tache aval, qui
  discrimine sur `Channel` la mecanique propre aux emails.
