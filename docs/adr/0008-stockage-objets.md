# ADR 0008 — Stockage d'objets compatible S3

Numéro 0008 imposé par la fiche T1A-11 ; il est déjà pris par l'exception de licence de nodemailer. L'architecte tranche la renumérotation à la relecture.

## Contexte
Exports, factures, pièces de suivi et artefacts signés vont dans un stockage d'objets : un compartiment `cli-<id>` par client, que les identifiants d'un autre client ne lisent ni n'écrivent. Le code ne parle que l'API S3 (C-522). Règle de la fiche : si MinIO n'est plus maintenu ou n'a plus d'images publiées, on prend une brique sous licence permissive ; sinon MinIO reste admis car jamais livré (A-379).

## Constat du 2026-10-25
| Brique | Maintenue | Images publiées | Licence |
|---|---|---|---|
| MinIO communautaire | non : le README du dépôt dit « THIS REPOSITORY IS NO LONGER MAINTAINED » | non : édition communautaire « distribuée en code source seulement », pas de binaires ; l'API Docker Hub ne connaît plus `minio/minio` | AGPL-3.0 |
| SeaweedFS | oui : version 4.50 dans le code, image republiée le jour même | oui : `chrislusf/seaweedfs` sur Docker Hub, étiquette `4.50`, empreinte `sha256:c2658820e763294a9e9de7b36c81e59b879e3459148351aee4e31a126ca64860` | Apache-2.0 (fichier LICENSE lu) |
| Garage | image `dxflrs/garage` republiée le jour même | oui | non relevée ici (page hors réseau) ; connue AGPL-3.0, donc non permissive : écartée sans constat |

Sources lues : README et LICENSE sur `raw.githubusercontent.com` (dépôts `minio/minio` et `seaweedfs/seaweedfs`), API publique de Docker Hub (`hub.docker.com/v2/repositories/…`).
Hors du réseau permis de la session, donc NON constatés : pages `github.com`, `min.io`, `seaweedfs.com`, `quay.io`, page de licence de Garage. Le chef d'orchestre peut les relever.
Non relevé non plus : la façon dont SeaweedFS exprime les droits par compartiment (identités S3 et actions limitées à un compartiment). La fiche demande de le tester, pas de le supposer : c'est le test d'intégration `@isolation` de l'étape 2.

## Décision
- MinIO est écarté (plus maintenu, plus d'images). La brique retenue est **SeaweedFS 4.50**, serveur S3, Apache-2.0.
- Le code ne parle que l'API S3 derrière un port (`PortS3`) : changer de brique ne réécrit que l'adaptateur.
- Étape 1 : ADR et couche S3 abstraite avec ses tests, sur une imitation. Aucun fichier sous `ops/briques/` ni `ops/socle/` tant que les PR de la chaîne ne sont pas fusionnées.
- Étape 2, après relecture : `ops/briques/stockage.json` (image épinglée par empreinte, à re-relever ce jour-là), fragment compose, `initialiser.sh`, tests `*.int.test.ts` contre la vraie brique.

## Conséquences
Si les droits par compartiment de SeaweedFS ne tiennent pas à l'essai, on retient une autre brique permissive sans toucher au code appelant. L'empreinte relevée aujourd'hui peut avoir changé à l'étape 2.

2026-10-25
