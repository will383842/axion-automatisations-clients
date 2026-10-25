# ADR 0015 — Image dérivée temporaire de LiteLLM

## Contexte
La garde Trivy refuse les images dont un avis critique corrigeable a plus de 7 jours ou un avis haut plus de 30 jours, sans exception pour la production. L'image `litellm-non_root` au dernier tag stable embarque des paquets Python vulnérables (dont `setuptools`) pour lesquels une version corrigée existe sur PyPI.

## Décision
- Image dérivée `ops/images/litellm-derivee/`, même processus que l'ADR 0014 : `FROM` unique épinglé par empreinte, même tag que la brique d'origine.
- `correctifs.txt` : une ligne `paquet==version --hash=sha256:…` par paquet, versions tirées du champ `FixedVersion` du rapport Trivy, empreintes tirées de PyPI. Jamais de ligne `litellm`.
- Installation : `pip install --no-deps --require-hashes`, puis `pip check` (la construction échoue si une version corrigée sort des bornes de LiteLLM), puis contrôle de la version de LiteLLM. L'utilisateur final est l'utilisateur non root de l'amont.
- `fumee.sh` : utilisateur identique à l'amont et non root, `pip check`, version, santé du serveur.
- Même workflow `images-derivees.yml` : construction sans publication sur PR ; publication sur `main` seulement, attestation de provenance sur l'empreinte poussée.
- Seuils inchangés, aucun `.trivyignore`, aucune exception. Un avis non corrigeable par dérivation reste rouge et la décision revient à Will.
- Retour à l'amont dès qu'il passe l'évaluateur.

## Conséquences
Une image à reconstruire quand l'amont change (Dependabot, écosystème `docker`) et un `correctifs.txt` à retailler. La publication GHCR reste soumise à la fusion et à la visibilité du paquet.

2026-10-25
