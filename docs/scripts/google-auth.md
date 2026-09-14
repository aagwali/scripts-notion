# Autorisation OAuth Google

| | |
|---|---|
| Script | [`scripts/google-auth.ts`](../../scripts/google-auth.ts) |
| Declencheur | **manuel, une seule fois** — jamais planifie |
| Secrets requis | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Secret produit | `GOOGLE_REFRESH_TOKEN`, ecrit dans `.env` |
| Bases Notion | aucune |
| Calendriers Google | aucun |

Utilitaire de bootstrap, pas un flux. Il ne lit ni n'ecrit aucune donnee
metier : il produit le refresh token dont dependent les quatre scripts Google
du repo ([import-gmail](import-gmail.md),
[sync-tasks-calendar](sync-tasks-calendar.md),
[sync-planning-aline](sync-planning-aline.md) et
[clean-docs](clean-docs.md)).

## Un seul client, un seul token, deux scopes

| Scope | Ce qu'il autorise | Ce qu'il n'autorise pas |
|---|---|---|
| `gmail.modify` | lecture, pose et retrait de labels, corbeille, **envoi** | la suppression definitive |
| `calendar.events` | lecture, ecriture, suppression d'evenements | creer ou supprimer un calendrier |

`gmail.modify` couvre `messages.send` : le digest de `clean-docs` part avec ce
meme scope, sans re-auth. Et `calendar.events` ne permettant pas de creer un
calendrier, les calendriers dedies (`Deadlines`, `Reminders`,
`Planning Aline`) sont crees a la main dans l'UI Google.

**Un refresh token porte les scopes accordes au moment de son emission.** Il
ne s'etend jamais tout seul : ajouter un scope dans `SCOPE` impose de relancer
ce script et de repousser le secret.

## Prerequis

Dans [console.cloud.google.com](https://console.cloud.google.com) :

- API Gmail **et** API Google Calendar activees ;
- un client OAuth de type **Desktop app** — obligatoire, c'est le seul type
  qui accepte un `redirect_uri` loopback sur port dynamique ;
- en mode Testing, votre compte ajoute comme *Test user*.

## Fonctionnement

Flux « loopback » (RFC 8252), le seul supporte par Google pour les scopes
Gmail : un serveur HTTP local ephemere sur `127.0.0.1`, port attribue par
l'OS, recoit le code d'autorisation, qui est ensuite echange contre un refresh
token.

Le flux « device code » n'est **pas** utilisable ici : Google le refuse pour
les scopes Gmail (`Invalid device flow scope`).

Deux details qui ont coute du temps, et qu'il ne faut pas « simplifier » :

- Le `redirect_uri` est fige des la mise en ecoute et conserve dans une
  variable de portee externe. Il doit etre **strictement identique** dans la
  requete d'autorisation et dans l'echange du code. Ne jamais le reconstruire
  depuis `server.address()` apres `close()` : cette methode renvoie `null` des
  que le serveur n'ecoute plus.
- `access_type: "offline"` est indispensable pour obtenir un refresh token, et
  `prompt: "consent"` force sa re-emission. Sans le second, Google peut
  repondre sans `refresh_token` si un consentement existe deja.

## Sorties

`GOOGLE_REFRESH_TOKEN` est ecrit dans `.env`, **en remplacant la ligne
existante** si elle est presente, sans toucher au reste du fichier. Le fichier
est cree s'il n'existe pas.

`.env` est git-ignore. Le verifier avant tout commit.

## Lancement

```
export GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="xxx"
npx tsx scripts/google-auth.ts
```

Le navigateur s'ouvre ; si rien ne s'ouvre, l'URL est affichee dans la
console. L'ecran « Google n'a pas valide cette application » est normal en
mode Testing : *Parametres avances* > *Continuer vers \<nom de l'app\>*.

Puis repousser le secret si les scripts sont planifies :

```
gh secret set GOOGLE_REFRESH_TOKEN --repo aagwali/scripts-notion --body "..."
```

## Idempotence et rejeu

**Rejouable sans risque, autant de fois que voulu.** Chaque run emet un
nouveau refresh token et remplace le precedent dans `.env`.

Attention toutefois : Google plafonne le nombre de refresh tokens vivants par
couple (client, compte). Au-dela, les plus anciens sont revoques
silencieusement — ce qui est sans consequence ici, le token precedent etant de
toute facon remplace.

## Rollback

Il n'y a rien a annuler cote Notion ou Google Calendar : ce script ne touche
aucune donnee.

- **Revoquer l'acces** : <https://myaccount.google.com/permissions>. Tous les
  scripts Google cessent alors de fonctionner jusqu'au prochain run de
  `google-auth.ts`.
- **Token precedent perdu** : il n'est pas recuperable, en regenerer un.
- Penser a repousser le secret GitHub apres chaque regeneration, sinon les
  workflows continuent d'utiliser l'ancien token jusqu'a son expiration.

## Limites connues

- **En mode Testing, le refresh token expire au bout de 7 jours.** C'est la
  contrainte structurante de tout le repo : tous les workflows Google tombent
  au 8e jour. Pour en sortir, voir
  [`docs/oauth-production.md`](../oauth-production.md) — decision du
  2026-09-13 : on reste en Testing pour l'instant, la verification de domaine
  etant bloquante.
- **Aucun `--dry-run`** : le flux OAuth est interactif par nature.
- **Le script n'ecrit que dans `.env`**, jamais dans les secrets GitHub : le
  `gh secret set` reste manuel.
- **Un seul compte Google** est couvert par ce client. Le repo n'a pas de
  notion de multi-compte.

## Depannage

- **`Aucun refresh_token retourne`** : un consentement existe deja sans
  `prompt=consent` effectif. Revoquer l'acces sur
  <https://myaccount.google.com/permissions>, puis relancer.
- **`Echange du code refuse (400)`** : le `redirect_uri` differe entre les
  deux appels, ou le client OAuth n'est pas de type *Desktop app*.
- **`Calendar API 403 ... insufficientPermissions`** : le refresh token a ete
  emis avant l'ajout du scope Calendar. Relancer ce script, et verifier que
  l'API Google Calendar est bien activee sur le projet Cloud.
- **`Rafraichissement du token refuse`** dans un autre script : token expire
  (mode Testing, 7 jours) ou revoque. Relancer ce script et repousser le
  secret.
