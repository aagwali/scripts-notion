# Sortir l'app OAuth du mode Testing

Runbook a executer une fois, quand l'occasion se presente. Rien ici n'est
urgent tant que `google-auth.ts` est relance a la main tous les 7 jours,
mais c'est le seul maillon de la chaine qui pourrit **en silence** : un
run GitHub Actions echoue sur un refus de rafraichissement, et rien ne
previent.

## Le probleme

L'ecran de consentement OAuth a deux etats de publication : *Testing* et
*In production*. En *Testing*, Google fait **expirer les refresh tokens
au bout de 7 jours**. Tous les scripts Google du repo en dependent :
`import-gmail`, `sync-tasks-calendar`, `sync-planning-aline`.

Deux scopes sont demandes par `scripts/google-auth.ts`, et leur
classification decide de la difficulte :

| Scope | Classification Google | Consequence |
|---|---|---|
| `calendar.events` | **Sensible** | publication en production sans friction particuliere |
| `gmail.modify` | **Restreint** | Google documente une exigence de verification |

C'est `gmail.modify` qui porte tout le risque. S'il n'y avait que
Calendar, l'affaire serait pliee en deux minutes.

## Etape 0 — Determiner l'etat actuel

Deux facons, la seconde etant la seule qui ne mente pas.

**Par la console.** [console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience)
— selectionner le bon projet, lire *Publishing status* (`Testing` ou
`In production`) et *User type* (`External`, forcement : `Internal`
demande un Google Workspace, et le compte est un `@gmail.com`).

**Par l'usage, qui tranche vraiment.** Ne pas relancer `google-auth.ts`
pendant 8 jours, puis :

```
npx tsx scripts/sync-planning-aline.ts --month 2026-09 --dry-run
```

- Le run passe -> le refresh token a survecu a la fenetre de 7 jours,
  l'app est deja en production.
- `invalid_grant` / refus de rafraichissement -> toujours en Testing.

> Le `.env` a ete regenere le **2026-09-05**. Ce test n'est donc
> exploitable qu'a partir du **2026-09-13**.

## Etape 1 — Publier en production

[console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience)
-> bouton **Publish app** -> confirmer.

Le statut passe a *In production*. Effet recherche : les refresh tokens
cessent d'expirer a 7 jours. Le plafond de 100 utilisateurs qui
accompagne une app non verifiee est sans objet ici — il y en a un seul.

Google affichera un avertissement indiquant que les scopes utilises
demandent une verification. **C'est le point d'incertitude du plan** :
la documentation exige la verification pour un scope restreint, mais en
pratique une app personnelle non verifiee publiee en production continue
de fonctionner, au prix d'un ecran d'avertissement au moment du
consentement. A confirmer au moment du clic — si la publication est
refusee ou remet l'app en attente de verification, passer au plan B.

## Etape 2 — Regenerer le token une derniere fois

```
npx tsx scripts/google-auth.ts
```

Au consentement, Google affiche **"Google n'a pas valide cette
application"**. C'est attendu pour une app non verifiee :
*Parametres avances* -> *Continuer vers ... (non securise)*.

Puis repousser le secret, sinon les workflows continuent avec l'ancien :

```
gh secret set GOOGLE_REFRESH_TOKEN --repo aagwali/scripts-notion --body "<valeur du .env>"
```

## Etape 3 — Verifier au bout de 8 jours

Refaire le test empirique de l'etape 0. S'il passe, le sujet est clos.

## Plan B — Separer les deux clients OAuth

A appliquer si l'etape 1 bute sur `gmail.modify`.

L'idee : arreter de faire porter par un seul client OAuth un scope
sensible et un scope restreint. Un client **Calendar** ne demandant que
`calendar.events` se publie sans difficulte ; le client **Gmail** reste
en Testing avec sa contrainte de 7 jours.

Resultat : `sync-planning-aline` et `sync-tasks-calendar` deviennent
stables, seul `import-gmail` garde la corvee. C'est le bon compromis vu
que le planning d'Aline tourne une fois par mois — precisement le rythme
ou une expiration a 7 jours est garantie de tomber au mauvais moment.

Ce que ca implique dans le repo :

- Un second client OAuth "Desktop app" dans le meme projet Cloud.
- Dedoubler les variables : `GOOGLE_CALENDAR_CLIENT_ID`,
  `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN` a cote
  des variables Gmail existantes. Trois secrets GitHub de plus.
- Parametrer `scripts/google-auth.ts` par jeu de scopes (un argument
  `--calendar` / `--gmail`), au lieu de la constante `SCOPE` unique.
- Basculer `sync-tasks-calendar.ts` et `sync-planning-aline.ts` sur les
  nouvelles variables.

Une demi-journee, pas davantage, mais inutile de la depenser tant que
l'etape 1 n'a pas ete tentee.

## Plan C — Verification complete

Site public, politique de confidentialite hebergee, propriete du domaine
verifiee, video de demonstration du parcours de consentement, puis
plusieurs semaines d'instruction cote Google. Disproportionne pour un
script personnel a un seul utilisateur. Mentionne pour memoire, pas pour
etre suivi.

## Ce qu'il ne faut pas tenter

- **`Internal` comme User type** : reserve aux comptes Google Workspace.
  Le compte est un `@gmail.com`, l'option n'apparaitra pas.
- **Un compte de service** : la delegation a l'echelle du domaine demande
  elle aussi un Workspace. Sans domaine, un compte de service ne peut pas
  agir au nom d'un compte Gmail personnel.
