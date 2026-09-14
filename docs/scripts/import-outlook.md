# Outlook -> Notion

| | |
|---|---|
| Script | [`scripts/import-outlook.ts`](../../scripts/import-outlook.ts) |
| Declencheur | LaunchAgent local `com.agwali.scripts-notion-outlook`, 23h00 heure locale |
| Secrets | `NOTION_TOKEN` |
| Lit | dossier OneDrive local, alimente par Power Automate |
| Ecrit | base Notion "Raw emails" (`ba36c9eb-2587-49e0-abd3-0d47276511c0`) |
| Calendriers Google | aucun |

Meme destination que [l'ingestion Gmail](import-gmail.md), source differente.
**Seul script du repo qui ne peut pas tourner sur GitHub Actions** : il depend
d'un dossier local, dont le chemin est code en dur.

## Fonctionnement

Outlook Pro n'expose rien via l'API (pas d'URL de message, pas de labels, pas
de `List-Unsubscribe`). Un flux Power Automate depose donc un fichier texte
par email dans un dossier OneDrive local :

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

Le parsing est tolerant a l'ordre et aux en-tetes absents, et accepte les
variantes anglaises (`From`, `Subject`, `Received`, `Message-Id`...). La
premiere ligne non reconnue, ou la premiere ligne vide apres au moins un
en-tete, marque le debut du corps. Si aucun en-tete n'est reconnu, le fichier
entier devient le corps et son nom devient l'objet.

Le script lit chaque fichier, cree la page Notion correspondante
(`Source = "Reply"`), puis deplace le fichier vers `.../emails/archive/`.

## Le bloc reunion

Cinq en-tetes supplementaires sont reconnus, poses par une action *Envoyer une
requete HTTP* de Power Automate placee avant le `Html to text` :
`Meeting start`, `Meeting end`, `Meeting location`, `Meeting recurrence` et
`Meeting timezone`.

`Meeting start` et `Meeting end` arrivent en heure locale nue
(`2026-09-07T12:00:00.0000000`). Le script recompose l'ISO 8601 avec offset en
resolvant `Meeting timezone`, en deux passes pour rester juste au basculement
ete/hiver, puis ecrit le resultat dans Notion. **`Meeting timezone` n'est pas
stockee** : il n'existe pas de propriete correspondante dans "Raw emails", le
fuseau est consomme puis jete. Sans consequence ici, toutes les sources du
systeme etant sur le meme fuseau — mais depuis Notion on ne voit plus que
l'instant absolu, jamais le fuseau d'annonce.

Le bloc de pied Teams (« Besoin d'aide ? » / « Need help? ») est **conserve
uniquement quand `Meeting start` est renseigne**, et supprime partout
ailleurs : c'est lui qui porte le lien « Reference systeme » dont la tache
aval a besoin. Voir
[Run quotidien email §2.0](https://app.notion.com/p/3cd8b4b88465815eb7bff0b74c7ad4ba).

Si l'action Power Automate est retiree ou echoue, la detection de reunion
retombe silencieusement sur une voie de repli cote tache aval (parsing d'un
bloc `When:` dans le corps). Symptome : une invitation classee en information
faible dans le digest.

## Ce qui est ecrit dans "Raw emails"

`Name`, `From`, `Body` (nettoye), `Received`, `Message ID`, `Thread ID`,
`Source = Reply`, `Status = To process`, plus `Meeting start`, `Meeting end`,
`Meeting location` et `Meeting recurrence` quand le bloc reunion est present.

Version degradee « best effort » assumee : **pas** de `Gmail URL`, **pas** de
`Labels`, **pas** d'`Unsubscribe URL`, et aucune mutation Gmail possible en
aval. Le discriminant cote tache aval est `Source = "Reply"`.

## Idempotence et rejeu

Deux garde-fous en serie :

- **L'archivage du fichier** porte la deduplication : un fichier traite quitte
  `inbound/`, il ne sera jamais relu.
- **Le controle `Message ID`** couvre la fenetre entre la creation de la page
  et le deplacement du fichier. Un fichier deja en base est archive sans
  reecriture.

Un fichier en echec **reste dans `inbound/`** et sera retente au run suivant.
C'est voulu : la perte d'un fichier perd l'email, qui n'existe nulle part
ailleurs de facon exploitable.

Attention au cas du fichier sans `Message ID` exploitable : le controle
d'existence est alors court-circuite (`if (!messageId) return false`), et un
rejeu creerait un doublon. En pratique Power Automate renseigne toujours cet
en-tete.

**Rejouer le script est sans effet de bord** tant que `inbound/` ne contient
que des fichiers non traites.

## Rollback

- **Annuler un import** : mettre la page "Raw emails" a la corbeille Notion
  (restaurable 30 jours) et, si l'email doit etre reimporte, redeplacer son
  fichier de `archive/` vers `inbound/`.
- **Rejouer un lot** : redeplacer les fichiers de `archive/` vers `inbound/`.
  Le controle `Message ID` empeche les doublons si les pages Notion existent
  toujours.
- `archive/` est la seule trace durable des fichiers sources : ne pas la vider
  sans raison.

## Lancement manuel

```
npx tsx scripts/import-outlook.ts
```

Ce script n'a **pas** de `--dry-run`.

## Planification : LaunchAgent local

Plist : `~/Library/LaunchAgents/com.agwali.scripts-notion-outlook.plist`
— declenche tous les jours a **23h00 heure locale**.

```
# recharger apres modification du plist
launchctl unload ~/Library/LaunchAgents/com.agwali.scripts-notion-outlook.plist
launchctl load ~/Library/LaunchAgents/com.agwali.scripts-notion-outlook.plist

# forcer un run manuel
launchctl start com.agwali.scripts-notion-outlook
```

Le plist source `nvm.sh` avant d'appeler `npx`, et redirige stdout et stderr
vers `logs/outlook.log`.

**A propos de la veille** : un ecran verrouille n'empeche pas le job de se
lancer (la session reste active). En revanche, fermer le capot met *toute la
machine* en veille — le job ne se declenche alors qu'au reveil suivant, pas a
23h pile. Si le Mac reste ouvert et **branche sur secteur**, `pmset` est
configure ici pour ne jamais dormir automatiquement sur secteur, donc le job
tourne a l'heure, ecran eteint ou non.

L'heure a ete ramenee de 3h30 a 23h justement pour reduire ce risque : a 23h
la machine est souvent encore ouverte, alors qu'a 3h30 le capot est
generalement ferme et le job ne partait qu'au reveil du lendemain.

Si ce compromis « best effort » ne convient toujours pas, un reveil programme
regle le cas sans rien reconstruire :

```
sudo pmset repeat wakeorpoweron MTWRFSU 22:55:00
```

(reveille la machine juste avant l'heure du job, meme capot ferme et sur
secteur).

## Logs

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
  meme pas declenche le job (ex : machine en veille toute la nuit). Le detail
  se trouve alors dans les logs systeme :
  ```
  log show --predicate 'process == "launchd"' --last 12h | grep scripts-notion-outlook
  ```
  ou via Console.app en filtrant sur `scripts-notion-outlook`.

Le log n'est pas purge automatiquement et `logs/` est git-ignore.

## Limites connues

- **Chemin OneDrive code en dur** ([`INBOUND_DIR`](../../scripts/import-outlook.ts#L31)).
  Le script est lie a cette machine et a ce compte.
- **OneDrive Files On-Demand** renvoie par intermittence `EAGAIN`, `EBUSY`,
  `ENOENT` ou `Unknown system error -11` sur un placeholder pas encore hydrate
  ou en cours d'ecriture. La lecture est donc retentee 3 fois (2s, 5s, 15s)
  avant d'abandonner. Des echecs subsistent malgre ce retry : le dernier run
  en date a laisse 4 fichiers dans `inbound/`, repris au run suivant.
- **Pas de retry ni de throttle Notion**, comme pour l'ingestion Gmail.
- **`Meeting timezone` n'est pas conservee** dans Notion (voir plus haut).
- Depend d'un flux Power Automate externe au depot, non versionne ici.

## Depannage

- **`command not found: npx` dans les logs du LaunchAgent** : launchd n'herite
  pas du PATH du shell interactif (nvm charge via `.zshrc` n'est pas source en
  mode non-interactif). Le plist source `nvm.sh` explicitement avant d'appeler
  `npx` — si `node`/`nvm` ont ete reinstalles ou deplaces, adapter la commande
  dans le plist.
- **Plist invalide (`plutil -lint` echoue)** : les caracteres `&`, `<`, `>`
  doivent etre echappes en XML (`&amp;`, `&lt;`, `&gt;`) dans les
  `ProgramArguments`.
- **`Dossier inbound introuvable`** : OneDrive n'est pas monte, ou le dossier
  a ete deplace. Le script sort en erreur sans rien tenter.
