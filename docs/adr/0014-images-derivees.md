# ADR 0014 — Images dérivées temporaires

Numéro 0014 : 0013 est réservé à l'exception Trivy des images d'essai, en cours de relecture dans une autre PR.

## Contexte
La garde Trivy refuse les images dont un avis critique corrigeable a plus de 7 jours ou un avis haut plus de 30 jours, sans exception pour la production. L'image PostgreSQL officielle en alpine embarque `gosu`, le seul binaire Go de l'image, compilé avec une bibliothèque standard vulnérable. Changer de version ou de base ne change rien : le même `gosu` est livré partout.

## Décision
- AXION IA construit et publie des images dérivées **temporaires** sur GHCR du dépôt public, depuis `ops/images/<nom>/`. Le `FROM` est unique et épinglé par empreinte.
- PostgreSQL : `rm` de `gosu` et `su-exec` (sans `-f`, pour échouer si l'amont déplace le binaire), puis `USER postgres`. Le script d'entrée n'appelle `gosu` qu'en root : démarré en non root, il n'est jamais appelé ; lancé en root, l'image s'arrête.
- Construction sans publication sur PR. Publication sur `main` seulement, avec `packages`, `id-token` et `attestations` en écriture dans ce seul job, le jeton automatique (aucun secret) et une attestation de provenance Sigstore portant l'empreinte poussée.
- Une seule action nouvelle, `actions/attest-build-provenance`, épinglée par SHA de 40 caractères et inscrite dans la liste blanche de `scripts/garde-licences.ts`. Aucune action docker tierce.
- Seuils Trivy inchangés, aucun `.trivyignore`, aucune exception.
- **Retour à l'amont** : dès que l'image amont passe l'évaluateur, on supprime l'image dérivée.

## Conséquences
Un paquet apk ou un binaire de moins à surveiller, mais une image à reconstruire quand l'amont change (Dependabot, écosystème `docker`). Un dossier de données monté depuis l'hôte devra appartenir à l'utilisateur 70. L'évaluateur `scripts/releve-trivy.ts` reprend les seuils de la garde des briques ; il sera réuni avec elle quand elle sera sur `main`.

2026-10-25
