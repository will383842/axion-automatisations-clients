# Environnements GitHub : gestes du chef d'orchestre (T1A-16, C-388, C-389)

Statut : première PR du squelette (règles de garde, Dockerfile, contrôle des réglages). Les workflows `images.yml` et `deploiement.yml` viennent dans la PR suivante, après décision sur la liste blanche de `scripts/garde-licences.ts` (voir la PR).

La seule route vers un serveur : `images.yml` construit et publie sur GHCR depuis `main` ; `deploiement.yml` se lance à la main, depuis `main`, dans un environnement qui attend l'accord de Will. Aucun agent, aucune PR, aucun workflow d'une PR ne touche un serveur.

## À créer (Réglages → Environments)
1. `production` : **Required reviewers** = Will (réviseur obligatoire) ; **Deployment branches** = « Selected branches », règle `main` seule. Option « Prevent self-review » selon la procédure d'équipe.
2. `recette` : **Deployment branches** = « Selected branches », règle `main` seule.
3. Le jeton d'appel de Coolify est un secret de **l'environnement** (nom `COOLIFY_JETON`), ajouté au lot 1-B. Jusqu'à là, le déploiement s'arrête avec « Non configuré ».
4. **Aucun** secret de déploiement au niveau du dépôt (Settings → Secrets → Actions).

## À vérifier
`ops/verifier-reglages-depot.sh` contrôle le réviseur de `production`, la branche `main` des deux environnements et l'absence de secret de déploiement au niveau du dépôt. Coller la sortie datée (tout OK) dans le dossier de reprise du dépôt privé et la ligne de preuve de C-389 dans `spec/preuves.md`.

## Rappels
- Le déploiement APPELLE Coolify depuis un exécuteur hébergé par GitHub ; il ne tourne jamais sur un serveur d'AXION IA (C-528).
- Il ne déploie qu'une image déjà publiée par `images.yml`, désignée par son empreinte `sha256:` ; jamais de code construit à la volée.
- `scripts/garde-workflows.ts` refuse : `COOLIFY` ou un environnement `production`/`recette` hors `deploiement.yml`, un autre déclencheur que `workflow_dispatch` pour `deploiement.yml`, `packages: write` hors du job `publier` de `images.yml`.

## Contrôles exigés de `main` : geste du chef d'orchestre (T1B-01, C-389)
À appliquer par le chef d'orchestre seul (droits d'administration), jamais par une routine, après T1B-08 et la fusion de la PR de recette intégrée du socle. Réglages → Branches → règle de `main` → « Require status checks » :
1. Garder les 13 contrôles déjà exigés.
2. Ajouter, avec ces noms exacts (ce sont les noms des jobs ; un nom faux bloque tout `main`) : `socle-integration`, `garde-briques`, `garde-migrations`, `garde-donnees`, `squelettes-web`. `compter-tests` y est déjà.
3. Relancer `ops/verifier-reglages-depot.sh` jusqu'à ce que tout soit OK, puis ajouter la ligne datée de C-389 (et de la partie « environnement production » de C-391) dans un fichier `spec/preuves/<branche>.md`. Tant que le script n'est pas tout OK : ne pas cocher C-389 ni C-391.
