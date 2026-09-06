# Nettoyage de la base Docs

Fichier : [`scripts/clean-docs.ts`](../scripts/clean-docs.ts)
Base concernee : "Docs" (`3448b4b8-8465-8016-876c-df35377f3d83`)

## Le probleme

Une tache aval depose chaque jour deux pages dans la base "Docs" : un
journal de run (`Type = Log`) et un digest email (`Type = Digest email`).
Relus le lendemain, ils n'ont plus de lecteur, mais ils continuent de
s'empiler — environ 60 pages par mois, qui noient les vrais documents de
la base (specs, procedures, references) dans les vues et dans le
selecteur de la relation `Docs`.

## Perimetre

Un doc est retenu s'il remplit les **trois** conditions :

| Condition | Valeur |
|---|---|
| `Type` | `Log` **ou** `Digest email` |
| `Status` | `Reviewed` |
| Age | strictement plus de 7 jours |

Les huit autres types (`Tech spec`, `Reference`, `Procedure`,
`Meeting notes`...) ne sont jamais touches, quel que soit leur age, et un
doc encore `To review` non plus — c'est le garde-fou qui evite de
supprimer un journal jamais lu.

## L'age se lit sur `created_time`, pas sur `Date`

La base porte pourtant une propriete `Date`. Elle n'est pas utilisee, pour
trois raisons :

- elle est **absente sur la moitie de ces pages** — la plupart des
  `Digest email` n'en portent pas. S'y fier laisserait ces pages sur
  place indefiniment, sans que rien ne le signale ;
- elle se saisit a la main, donc une faute de frappe peut avancer une
  suppression ;
- sur les pages qui portent les deux, les valeurs **coincident** : la
  propriete n'apportait rien.

`created_time` est pose par Notion, toujours present, non modifiable. Le
seul ecart possible est une page creee apres coup pour un jour passe :
elle est alors gardee plus longtemps, jamais supprimee plus tot.

Le jour de reference est calcule dans `Europe/Paris`, pas dans le fuseau
du runner. Une page creee a 23h30 heure de Paris est datee du lendemain en
UTC, et serait comptee un jour trop jeune.

## Corbeille, pas suppression

Le script fait `archived: true` : la page part a la **corbeille Notion**,
qui la conserve **30 jours** avant suppression definitive. C'est la vraie
fenetre de rollback, la meme que pour
[l'archivage des phases](archive-phases.md). Le digest liste les liens
`https://app.notion.com/p/<id>`, qui restent valables une fois la page en
corbeille.

Rien n'est recopie ailleurs : contrairement aux phases, ces pages n'ont
pas de relation entrante a preserver, et leur contenu est par nature
perissable. Passe 30 jours il n'y a plus rien a restaurer — c'est le but.

## Le digest

Un email part **a chaque run**, du compte Google authentifie vers
lui-meme. L'adresse n'est pas configuree : le script la lit sur
`gmail/v1/users/me/profile`, donc rien de personnel n'entre dans le
depot.

Il est envoye **meme quand rien n'a ete nettoye**. Recevoir « 0 doc »
chaque dimanche dit que le job a tourne ; un silence ne le dit pas, et ne
se distingue pas d'un workflow casse. C'est aussi la trace durable du
nettoyage : les logs GitHub Actions, eux, expirent a 90 jours.

Le sujet est volontairement en ASCII — `[Docs cleaning] N doc(s) en
corbeille`, suffixe de `, M echec(s)` si une mise a la corbeille a rate —
ce qui evite l'encodage RFC 2047 des en-tetes. Le corps, qui porte des
titres accentues, part en base64 UTF-8.

Si l'envoi echoue **apres** le nettoyage, le digest complet est deverse
dans le log du run et le script sort en erreur : la trace n'est jamais
perdue silencieusement.

L'envoi utilise le meme scope `gmail.modify` que l'ingestion Gmail : ce
scope couvre `messages.send`, aucun re-auth n'est necessaire.

## Lancement manuel

```
npx tsx scripts/clean-docs.ts --dry-run   # simulation, aucune corbeille, aucun email
npx tsx scripts/clean-docs.ts             # pour de vrai
```

Le `--dry-run` affiche le perimetre doc par doc (garde / corbeille) puis
**l'apercu exact du digest** qui serait envoye.

## Planification : GitHub Actions

Workflow : [`.github/workflows/clean-docs.yml`](../.github/workflows/clean-docs.yml)

- Declenchement hebdomadaire, le dimanche a `03:00` UTC (5h a Paris en
  ete). Voir les [reserves sur les crons](../README.md#planification).
- La cadence hebdomadaire et la retention de 7 jours sont independantes :
  un doc vit donc entre 7 et 14 jours selon le jour ou il est ne.
- Secrets requis : `NOTION_TOKEN`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.
- Declenchement manuel :
  ```
  gh workflow run "Clean Docs (Notion)" --repo aagwali/scripts-notion
  gh workflow run "Clean Docs (Notion)" --repo aagwali/scripts-notion -f dry_run=true
  ```

## Logs

La trace de reference est le **digest email**, pas le log : il arrive
chaque dimanche dans la boite Gmail et n'expire pas. Le log du run reprend
la meme information, plus le detail des docs gardes et leur age.

```
gh run list --repo aagwali/scripts-notion --workflow "Clean Docs (Notion)" --limit 5
gh run view <run-id> --repo aagwali/scripts-notion --log
```

Le workflow sort en erreur si une mise a la corbeille echoue, ou si
l'envoi du digest echoue — dans ce dernier cas le digest complet est dans
le log.
