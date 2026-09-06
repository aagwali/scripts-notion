# Gmail -> Notion

Fichier : [`scripts/import-gmail.ts`](../scripts/import-gmail.ts)
Base concernee : "Raw emails" (`ba36c9eb-2587-49e0-abd3-0d47276511c0`)

Alimente la base "Raw emails" depuis la boite Gmail. Chaque page creee porte
`Status: "To process"`, consomme ensuite par une tache aval (non incluse ici).

## Fonctionnement

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

## Lancement manuel

```
npx tsx scripts/import-gmail.ts
```

Prerequis : le client OAuth Google et `GOOGLE_REFRESH_TOKEN` doivent etre en
place — voir [Prerequis communs](../README.md#prerequis-communs).

## Planification : GitHub Actions

Workflow : [`.github/workflows/import-gmail.yml`](../.github/workflows/import-gmail.yml)

- Declenchement quotidien a `20:00` UTC (22h a Paris en ete). Voir les
  [reserves sur les crons](../README.md#planification) : UTC fige et runs
  potentiellement retardes.
- Secrets requis : `NOTION_TOKEN`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. C'est ce workflow qui les
  a poses en premier, les autres les reutilisent :
  ```
  gh secret set NOTION_TOKEN --repo aagwali/scripts-notion --body "..."
  gh secret set GOOGLE_CLIENT_ID --repo aagwali/scripts-notion --body "..."
  gh secret set GOOGLE_CLIENT_SECRET --repo aagwali/scripts-notion --body "..."
  gh secret set GOOGLE_REFRESH_TOKEN --repo aagwali/scripts-notion --body "..."
  ```
- Le cron GitHub Actions ne se declenche que sur la **branche par
  defaut** (`main`) — pusher ailleurs ne suffit pas.
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
- Un seul run attendu chaque nuit, autour de `20:00` UTC — l'heure reelle
  de declenchement peut varier.
