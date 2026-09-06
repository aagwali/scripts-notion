# Outlook -> Notion

Fichier : [`scripts/import-outlook.ts`](../scripts/import-outlook.ts)
Base concernee : "Raw emails" (`ba36c9eb-2587-49e0-abd3-0d47276511c0`)

Meme destination que [l'ingestion Gmail](gmail.md), source differente. Seul
script du repo qui ne peut pas tourner sur GitHub Actions.

## Fonctionnement

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

## Lancement manuel

```
npx tsx scripts/import-outlook.ts
```

## Planification : LaunchAgent local

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
  meme pas declenche le job (ex : machine en veille toute la nuit). Le
  detail se trouve alors dans les logs systeme :
  ```
  log show --predicate 'process == "launchd"' --last 12h | grep scripts-notion-outlook
  ```
  ou via Console.app en filtrant sur `scripts-notion-outlook`.

## Depannage

- **`command not found: npx` dans les logs du LaunchAgent** : launchd
  n'herite pas du PATH du shell interactif (nvm charge via `.zshrc` n'est
  pas source en mode non-interactif). Le plist source `nvm.sh`
  explicitement avant d'appeler `npx` — si `node`/`nvm` ont ete
  reinstalles ou deplaces, adapter la commande dans le plist.
- **Plist invalide (`plutil -lint` echoue)** : les caracteres `&`, `<`,
  `>` doivent etre echappes en XML (`&amp;`, `&lt;`, `&gt;`) dans les
  `ProgramArguments`.
