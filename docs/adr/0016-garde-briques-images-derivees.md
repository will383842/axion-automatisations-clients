# ADR 0016 — Garde des briques : images dérivées et attestation

Numéro 0016 : 0015 est réservé à la construction de l'image dérivée LiteLLM. Complète l'ADR 0014.

## Contexte
L'ADR 0014 fait publier par la CI des images dérivées temporaires. La garde des briques doit pouvoir les inscrire sans qu'une empreinte inventée, poussée à la main ou venue d'une autre source puisse passer.

## Décision
- Une brique peut porter une clé `derivee` : `amont` (image amont épinglée par `@sha256:`) et `dockerfile` (`ops/images/<dossier>/Dockerfile`).
- La garde refuse une brique dérivée dont l'image est hors `ghcr.io/will383842/axion-automatisations-clients/`, dont l'empreinte est celle de l'amont, ou qui porte une `exception_trivy`.
- Le Dockerfile cité doit exister, avoir un seul `FROM` égal à `amont`, ne rien télécharger (`ADD` d'une adresse, `curl`, `wget`, `| sh`, `COPY --from`) et ne déclarer aucun `ARG` ou `ENV` dont le nom contient TOKEN, KEY, SECRET ou PASSWORD.
- `garde-briques.yml` exécute `gh attestation verify` avec `--repo` et `--signer-workflow …/images-derivees.yml` pour chaque brique dérivée, après la garde des fichiers. La garde relit ensuite la sortie JSON : empreinte attestée identique à celle de la brique, signataire exact `images-derivees.yml` sur `refs/heads/main` de ce dépôt. Sans attestation, l'étape est rouge.
- La garde refuse aussi, dans un compose, `build:` (même avec `image:`), `provider:`, une `image` qui n'est pas un texte, `pull_policy` autre que `always` ou `missing`, `include:` et `extends.file` : une image se tire du registre, rien n'entre par un fichier non lu. Une brique dont l'image est sous notre dépôt GHCR doit porter `derivee`, et son image ne porte aucun port dans le nom d'hôte. Les composes du dépôt citent les images publiées.
- Seule permission ajoutée : `attestations: read`.
- Limite connue : la lecture du Dockerfile est une aide à la relecture, pas une barrière (directive `escape`, `RUN` qui installe ou télécharge sous une autre forme). La barrière est la construction par `images-derivees.yml` sur `main` et l'attestation. Les fichiers de la garde relèvent de la relecture humaine.

## Conséquences
Les empreintes des briques dérivées ne peuvent venir que de la CI de `main`. Les briques `postgres` et `postgres-socle` portent les empreintes publiées par `images-derivees.yml` sur `main`, lues dans le résumé du job `publier`. LiteLLM suivra avec l'image D2. Trivy sur les images inscrites est ajouté par une PR suivante.

2026-10-25
