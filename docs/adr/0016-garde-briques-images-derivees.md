# ADR 0016 — Garde des briques : images dérivées et attestation

Numéro 0016 : 0015 est réservé à la construction de l'image dérivée LiteLLM, en cours dans une autre PR. Complète l'ADR 0014.

## Contexte
L'ADR 0014 fait publier par la CI des images dérivées temporaires. La garde des briques doit pouvoir les inscrire sans qu'une empreinte inventée, poussée à la main ou venue d'une autre source puisse passer.

## Décision
- Une brique peut porter une clé `derivee` : `amont` (image amont épinglée par `@sha256:`) et `dockerfile` (`ops/images/<dossier>/Dockerfile`).
- La garde refuse une brique dérivée dont l'image est hors `ghcr.io/will383842/axion-automatisations-clients/`, dont l'empreinte est celle de l'amont, ou qui porte une `exception_trivy`.
- Le Dockerfile cité doit exister, avoir un seul `FROM` égal à `amont`, ne rien télécharger (`ADD` d'une adresse, `curl`, `wget`, `| sh`, `COPY --from`) et ne déclarer aucun `ARG` ou `ENV` dont le nom contient TOKEN, KEY, SECRET ou PASSWORD.
- `garde-briques.yml` exécute `gh attestation verify` avec `--repo` et `--signer-workflow …/images-derivees.yml` pour chaque brique dérivée, avant Trivy. La garde relit ensuite la sortie JSON : empreinte attestée identique à celle de la brique, signataire exact `images-derivees.yml` sur `refs/heads/main` de ce dépôt. Sans attestation, l'étape est rouge.
- Seule permission ajoutée : `attestations: read`. Seuils Trivy et absence d'exception inchangés.

## Conséquences
Les empreintes des briques dérivées ne peuvent venir que de la CI de `main`. Les fichiers `ops/briques/{postgres,litellm}.json` ne passent en dérivé qu'avec les empreintes publiées (PR suivantes, après D1 et D2).

2026-10-25
