# Images dérivées temporaires

Une image dérivée est une image amont (épinglée par empreinte) avec le strict minimum retiré ou corrigé, quand l'amont ne passe pas la garde Trivy (critique 7 jours, haute 30 jours). Règle de l'ADR 0014 : on revient à l'amont dès qu'il est vert.

| Dossier | Amont | Correction |
|---|---|---|
| `postgres/` (`postgres-socle`) | `postgres:16@sha256:9e2c…` (Debian, avec pg_partman) | retire `gosu` ; démarre en utilisateur `postgres` (uid 999) |
| `postgres-derivee/` | `postgres:16.15-alpine@sha256:f461…` | retire `gosu` et `su-exec` (binaire Go vulnérable) ; démarre en utilisateur `postgres` |
| `postgres-sauvegarde/` | `postgres-socle:16-r41@sha256:c5fd…` | ajoute pgBackRest (MIT, version épinglée) et le client SSH pour les sauvegardes (T1A-14) ; reste en utilisateur `postgres` (uid 999) |

L'image du socle de développement (`ops/images/postgres/`, avec pg_partman) est construite, scannée (Trivy 7/30 jours, aucune exemption) et publiée sous le nom `postgres-socle` par le même workflow, avec la même attestation. `ops/socle/compose.postgres.yml` cite cette image publiée (`image: …@sha256:`, empreinte relevée dans le journal du job `publier` sur `main`, à confirmer dans son résumé par Will) ; la garde des briques refuse un service `build:` sans `image:` et vérifie l'attestation de chaque image dérivée (ADR 0016).

## Construction et publication
- `.github/workflows/images-derivees.yml`. Sur une PR : construction, test de fumée, Trivy, évaluateur. Aucune publication.
- Sur `main` seulement : publication sur GHCR avec le jeton automatique du job (aucun secret), puis attestation de provenance. L'empreinte publiée est celle du job `publier` sur `main` ; la routine ne lit que le journal, Will confirme dans le résumé.
- `node scripts/releve-trivy.ts --releve <rapport>` liste les avis : paquet, version installée, version corrigée, chemin.

## Monter la version de pgBackRest
La version est épinglée exactement (`PGBACKREST_VERSION`, `postgres-sauvegarde/Dockerfile`). L'image ajoute la source d'archive PGDG (`apt-archive.postgresql.org`, `trixie-pgdg-archive`), qui garde toutes les versions : l'épinglage ne casse pas quand une nouvelle version sort.
1. Choisir la version dans l'archive PGDG (forme `X.Y.Z-1.pgdg13+1`).
2. La changer dans `PGBACKREST_VERSION` et dans le test de fumée `grep '^pgBackRest X\.Y\.Z'` de `.github/workflows/images-derivees.yml`.
3. Laisser la CI passer, puis suivre l'ordre de publication habituel (empreinte relevée dans le journal du job `publier`).

## Conséquences du démarrage non root
Un volume nommé fonctionne tel quel. Un dossier de l'hôte monté doit appartenir à `70:70`. Lancée en root, l'image s'arrête (échec fermé).
