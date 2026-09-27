# App OAuth Google : mode Testing

L'app OAuth du projet Cloud est en *Testing*, User type *External*. Elle y
reste : cette page dit pourquoi, ce qu'il faudrait pour en sortir, et le piege
a connaitre en attendant.

## Consequence : un token de 7 jours

En *Testing*, Google fait **expirer les refresh tokens au bout de 7 jours**.
Les cinq scripts Google du repo en dependent : `import-gmail`,
`sync-tasks-calendar`, `sync-planning-aline`, `roll-post-it`, `clean-docs`.

C'est le seul maillon de la chaine qui casse **en silence** : un run GitHub
Actions echoue sur un refus de rafraichissement, et rien ne previent. La parade
est une regeneration manuelle hebdomadaire — `google-auth.ts` puis
`gh secret set`, voir [`google-auth.md`](scripts/google-auth.md#lancement) —
rappelee par un evenement recurrent de la base Notion "Recurring events".

## Pourquoi l'app ne passe pas en production

Deux scopes sont demandes par `scripts/google-auth.ts` :

| Scope | Classification Google | Consequence |
|---|---|---|
| `calendar.events` | **Sensible** | publication en production sans friction particuliere |
| `gmail.modify` | **Restreint** | Google exige une verification |

Le bouton **Publish app** reste grise tant que l'onglet **Branding** du
consentement n'a pas ses quatre champs : nom de l'appli, email d'assistance,
URL de la page d'accueil, URL de la politique de confidentialite. Le repo
etant prive, ces URLs peuvent pointer vers deux pages Notion publiees sur le
web (`*.notion.site`, sous-domaine complet en *Authorized domain* — la racine
`notion.site` est refusee).

Le blocage est a l'etape suivante : la validation du Branding exige de
**prouver la propriete du domaine** (Search Console), impossible sur une page
Notion. Ce controle porte sur le **projet Cloud entier**, pas sur un client
OAuth : un second client dans le meme projet ne le contourne pas, tant que
`gmail.modify` y est declare quelque part.

## Ce qu'il faudrait pour en sortir

**Un second projet Cloud, dedie a Calendar.** Un projet ne declarant que
`calendar.events` (sensible) echappe a l'exigence qui pese sur `gmail.modify`.
`sync-tasks-calendar`, `sync-planning-aline` et `roll-post-it` deviendraient
stables ; `import-gmail` et `clean-docs` garderaient la contrainte des 7 jours.
Piste non tentee. Ce qu'elle implique dans le repo :

- un client OAuth *Desktop app* dans ce second projet ;
- des variables dediees (`GOOGLE_CALENDAR_CLIENT_ID`,
  `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN`) a cote des
  variables Gmail, et autant de secrets GitHub ;
- `scripts/google-auth.ts` parametre par jeu de scopes (`--calendar` /
  `--gmail`) plutot que par la constante `SCOPE` unique ;
- les trois scripts Calendar branches sur les nouvelles variables.

**La verification complete** : site public, politique de confidentialite
hebergee, propriete du domaine verifiee, video du parcours de consentement,
plusieurs semaines d'instruction cote Google. Disproportionne pour un script
personnel a un seul utilisateur.

**Ce qu'il ne faut pas tenter :**

- **`Internal` comme User type** : reserve aux comptes Google Workspace. Le
  compte est un `@gmail.com`, l'option n'apparait pas.
- **Un compte de service** : la delegation a l'echelle du domaine demande elle
  aussi un Workspace. Sans domaine, un compte de service ne peut pas agir au
  nom d'un compte Gmail personnel.

## Verifier l'etat de l'app

**Par la console.** [console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience)
— selectionner le bon projet, lire *Publishing status* (`Testing` ou
`In production`).

**Par l'usage, qui tranche.** Huit jours apres la derniere regeneration du
token, sans la refaire :

```
npx tsx scripts/sync-planning-aline.ts --dry-run
```

- Le run passe -> le refresh token a survecu a la fenetre de 7 jours, l'app
  est en production.
- `invalid_grant` / refus de rafraichissement -> toujours en Testing.

## Piege : la liste Test users peut se vider

Une bascule Testing -> Production -> Testing peut vider la liste **Test
users** de l'ecran de consentement. `google-auth.ts` echoue alors au
consentement (le compte n'est plus autorise), meme avec un Client ID/Secret
corrects.

Reflexe des qu'une regeneration echoue de facon inhabituelle : verifier
**OAuth consent screen -> Audience -> Test users** avant de chercher plus loin,
et reajouter son propre compte si la liste est vide. Le vidage n'est pas
avere systematique.
