# 0043 · Déploiement seulement par `workflow_dispatch` depuis `main`, environnement à réviseur, image déjà construite

Date : 29/10/2026 · Statut : proposé (T1B-02, consigne ce qui est livré au lot 1-A ; relecture de l'architecte du lot demandée) · Contrat touché : aucun

## Contexte
Décision d'architecte n° 9 du sommaire du lot 1-A. La seule route vers un serveur doit être unique, à l'accord d'une personne, et ne jamais construire du code à la volée (C-388, C-389, C-528).

## Décision
- `images.yml` construit et publie l'image sur le registre depuis `main` seulement. `deploiement.yml` se lance **à la main** (`workflow_dispatch` seul), depuis `main`.
- Il vise un environnement GitHub : `production` avec **réviseur obligatoire** (le responsable du produit), `recette` sans réviseur ; les deux limités à la branche `main`.
- Il ne déploie qu'une image **déjà publiée**, désignée par son empreinte `sha256:`.
- Le jeton d'appel de l'outil de déploiement est un secret de l'environnement, jamais du dépôt. Tant qu'il manque, le déploiement s'arrête avec « Non configuré ».
- Le déploiement appelle l'outil depuis un exécuteur hébergé par GitHub ; il ne tourne jamais sur un serveur d'AXION IA. Aucun agent, aucune PR ni aucun workflow de PR ne touche un serveur.
- `scripts/garde-workflows.ts` refuse un environnement `production` ou `recette` hors `deploiement.yml`, un autre déclencheur que `workflow_dispatch` pour ce fichier, et `packages: write` hors du job de publication. `ops/verifier-reglages-depot.sh` contrôle les réglages du dépôt.

## Conséquences
- Un déploiement demande un geste humain et un accord ; pas de déploiement continu.
- Revenir en arrière = relancer avec l'empreinte d'une image précédente.
- État au moment de cet ADR : règles de garde, Dockerfile et contrôle des réglages livrés ; les workflows `images.yml` et `deploiement.yml` suivent dans une PR séparée (voir `ops/environnements-github.md`).

Fiche : T1A-16 (chaîne de déploiement protégée, squelette).
