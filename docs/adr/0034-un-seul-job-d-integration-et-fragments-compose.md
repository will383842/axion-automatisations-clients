# 0034 · Un seul job d'intégration alimenté par des fragments compose

Date : 29/10/2026 · Statut : proposé (T1B-02, consigne ce qui est livré au lot 1-A ; relecture de l'architecte du lot demandée) · Contrat touché : aucun

## Contexte
Décision d'architecte n° 1 du sommaire du lot 1-A. Chaque brique du socle (base, files, coffre, connexion, passerelle, stockage, sauvegardes) a sa fiche. Si chaque fiche réécrivait le workflow de CI, elles se marcheraient dessus (ADR 0029) et un workflow de CI est un fichier à risque.

## Décision
- Un seul job de CI, `socle-integration`, lance tout le socle avec `ops/socle/lancer.sh`.
- Le lanceur assemble `ops/socle/compose.base.yml` et tous les `compose.<brique>.yml` (ordre alphabétique) ; un fragment plus loin dans l'ordre peut redéfinir un service.
- Ajouter une brique = ajouter un fragment, jamais modifier le workflow.
- `scripts/garde-compose.ts` contrôle le compose assemblé : seul le proxy publie un port, images épinglées par `@sha256:`, ni `privileged`, ni socket Docker, services internes sur le réseau `interne`, noms d'hôte en `.test`.
- Les tests `*.int.test.ts` ne tournent que si `SOCLE_INTEGRATION=1` ; `pnpm test` ne les lance pas.

## Conséquences
- Une fiche de brique ne touche que son fragment, ses tests et sa documentation.
- Les sessions cloud n'ont pas de conteneurs : la preuve d'une brique est le job `socle-integration` de la PR, pas un essai local.
- Un fragment qui casse le démarrage casse le job pour tous : la garde du compose assemblé est la première défense.

Fiches : T1A-01 (compose et job), puis chaque fiche de brique T1A-03 à T1A-16. Voir aussi l'ADR 0029.
