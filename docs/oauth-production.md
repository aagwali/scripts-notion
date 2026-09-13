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

## Etape 0.5 — Completer le Branding (prealable decouvert le 2026-09-13)

Le bouton **Publish app** reste grise tant que l'onglet **Branding** du
consentement n'a pas ces quatre champs : nom de l'appli, email
d'assistance, URL de la page d'accueil, URL de la politique de
confidentialite. Le repo etant prive, il n'y avait pas de page publique a
pointer.

Solution retenue : deux pages Notion publiees sur le web (Partager ->
Publier sur le web), qui donnent des URLs `*.notion.site` a coller dans
Branding. Gratuit, immediat, pas besoin d'un plan GitHub payant pour des
GitHub Pages depuis un repo prive.

Point d'incertitude non tranche : Google demande parfois une verification
de propriete de domaine (Search Console) pour les "Authorized domains".
`notion.site` etant un domaine partage, statut a verifier au moment du
clic sur Publish. Si ca bloque, ne pas s'engager dans la verification de
domaine — basculer directement sur le Plan B.

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

## Piege observe — la liste Test users peut se vider

Le 2026-09-13, une tentative de publication suivie d'un retour a Testing
a vide la liste **Test users** de l'ecran de consentement. Consequence :
`google-auth.ts` echoue au moment du consentement (le compte n'est plus
autorise), meme si Client ID/Secret sont corrects.

Reflexe a avoir des qu'une regeneration echoue de facon inhabituelle :
verifier **OAuth consent screen -> Audience -> Test users** avant de
chercher plus loin, et reajouter son propre compte si la liste est vide.
Rien n'indique que ce vidage soit systematique a chaque bascule
Testing/Production/Testing — a confirmer si ca se reproduit.

## Decision du 2026-09-13 — reste en Testing

Tentative de sortie de Testing menee jusqu'au bout : Branding complete
avec deux pages Notion publiees sur le web (`*.notion.site`, le
sous-domaine complet passe en Authorized domain, la racine `notion.site`
non). Blocage final : la validation du Branding exige de **prouver la
propriete du domaine** (Search Console), impossible sur une page Notion.
Ce controle porte sur le **projet Cloud entier**, pas sur un client OAuth
individuel — le Plan B ci-dessous (deuxieme client *dans le meme projet*)
ne l'aurait donc pas contourne tant que `gmail.modify` reste declare
quelque part dans ce projet. Un Plan B efficace demanderait un second
**projet Cloud** distinct pour Calendar, pas juste un second client.

Decision retenue : rester en Testing partout. Un evenement recurrent
hebdomadaire (dimanche) a ete cree dans la base Notion "Recurring events"
pour rappeler la regeneration manuelle — voir la vue "Daily".

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
