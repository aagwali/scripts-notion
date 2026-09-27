# Report Post-it

| | |
|---|---|
| Script | [`scripts/roll-post-it.ts`](../../scripts/roll-post-it.ts) |
| Declencheur | GitHub Actions, quotidien `0 4 * * *` UTC (6h a Paris en ete) |
| Secrets | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
| Lit / ecrit | calendrier Google `Post-it` (config `google.calendars.postIt`) |
| Notion | aucun acces |

## Fonctionnement

Le calendrier Post-it porte des evenements crees a la main, sans tache Notion
derriere. La convention est que **supprimer l'evenement vaut "fait"**. Un
evenement encore present une fois sa journee passee n'a donc pas ete fait :
chaque matin, le script le ramene sur aujourd'hui, jusqu'a ce qu'il soit
supprime.

| Evenement | Action |
|---|---|
| termine avant minuit aujourd'hui (Paris) | deplace sur aujourd'hui, en journee entiere |
| en cours, du jour ou a venir | rien |
| recurrent (serie ou occurrence) | rien, logue comme ignore |

L'evenement revient **toujours en journee entiere**, meme s'il portait une
heure : un creneau horaire appartient a sa journee, rien ne garantit qu'il
soit libre le lendemain. Il est a replacer a la main si besoin. Titre,
description et couleur ne sont pas touches.

"Termine avant minuit" se lit ainsi : pour une journee entiere, la fin Google
est exclusive, donc une journee de la veille finit a aujourd'hui et est
passee ; un evenement sur plusieurs jours qui deborde sur aujourd'hui ne l'est
pas. Pour un creneau horaire, on compare sa fin a minuit heure de Paris ; un
creneau a cheval sur minuit n'est pas passe. Minuit est calcule dans
`Europe/Paris`, pas dans le fuseau du runner, changements d'heure compris :
ces cas sont couverts par [`roll-post-it.test.ts`](../../scripts/roll-post-it.test.ts).

## Perimetre, idempotence et rejeu

Aucune fenetre de temps : le script liste tout ce qui a commence avant minuit.
Par construction, tout ce qui reste dans le passe du calendrier est un
reliquat. Un run manque est donc rattrape par le suivant, quel que soit
l'ecart.

**Rejouer le script est sans effet de bord** : un evenement deplace est sur
aujourd'hui, il n'est plus passe et n'est plus touche. Un evenement en echec
n'empeche pas les autres ; le run sort en erreur et le suivant le reprendra.

## Rollback

Le script ne supprime rien et ne cree rien : il ne fait que deplacer. Un
evenement deplace a tort se replace a la main. Le log de chaque run nomme,
pour chaque evenement, son titre, sa date d'origine et son id.

## Lancement manuel

```
npx tsx scripts/roll-post-it.ts --dry-run   # simulation : liste ce qui serait deplace
npx tsx scripts/roll-post-it.ts             # pour de vrai
```

## Planification : GitHub Actions

Workflow : [`.github/workflows/roll-post-it.yml`](../../.github/workflows/roll-post-it.yml)

- Cron avant le reveil (voir l'en-tete) : les Post-it non faits de la veille
  sont deja sur la journee quand on l'ouvre. Aucune dependance avec un autre
  flux. [Reserves communes](../../README.md#planification).
- Declenchement manuel :
  ```
  gh workflow run "Report Post-it (Google Calendar)" --repo aagwali/scripts-notion
  ```

## Scope Calendar

Meme exigence que [`sync-tasks-calendar`](sync-tasks-calendar.md#scope-calendar) :
le `GOOGLE_REFRESH_TOKEN` doit couvrir `calendar.events`.

## Limites connues

- **Les evenements recurrents ne sont jamais reportes.** Une recurrence n'a
  rien d'une action eclair ; en poser une dans Post-it la laisse vivre sa vie.
- **L'heure est perdue au report**, volontairement. Un Post-it a heure fixe
  non fait revient en journee entiere.
- **Un evenement sur plusieurs jours, passe, revient sur une seule journee.**
