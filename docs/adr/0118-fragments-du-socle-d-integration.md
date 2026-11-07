# 0118 · Fragments du socle d'intégration et contrôle requis rassembleur

Date : 06/11/2026 · Statut : proposé (lot CI, relecture de l'architecte demandée) · Contrat touché : aucun · Remplace en partie : ADR 0034 (la décision « un seul job »)

## Contexte
Le contrôle requis `socle-integration` durait plus de 11 minutes par exécution, sur chaque PR puis sur `main`. Le plan V2 de la CI (validé par l'audit tour 2) le découpe en fragments parallèles sans retirer aucune garantie.

## Décision
- Trois jobs `fragment-1`, `fragment-2`, `fragment-3` (noms `socle-integration-fragment-N`), écrits un par un, sans matrice. Chacun monte son propre socle neuf (même garde du compose, même `ops/socle/lancer.sh`), lance `vitest run --project integration --shard=N/3 --reporter=blob`, envoie son rapport (rétention 1 jour, pas d'envoi si rouge) et arrête le socle en `if: always()`.
- Le job `socle-integration` (même identifiant, même `name`) devient le rassemblement : `needs` tous les fragments, `if: always()`, et refus de tout résultat autre que `success success success`. **Ne jamais le remplacer par `!cancelled()`** : un job requis « sauté » vaut réussi pour la protection de `main`.
- Le rassemblement fusionne les rapports (`vitest --merge-reports`) puis relance le socle avant le compteur : `vitest list` importe des fichiers qui interrogent Docker au chargement. `scripts/compter-tests.ts` n'est pas modifié (ADR 0019 : le compteur reste la dernière étape utile de `socle-integration`, avant l'arrêt).
- `actions/download-artifact` v8.0.2, SHA `9000827ccba6bdab643e8b6fd33ac0654aef8333` (tags `v8` et `v8.0.2` du dépôt officiel, licence MIT lue à ce SHA, même bibliothèque d'artefacts que `upload-artifact` v7.0.1). La garde ne lit pas les licences d'action : vérification manuelle faite ici. Réglages exacts en liste blanche, aucun `github-token` ni `run-id` : même exécution seulement.
- Délais : 45 minutes par fragment, 30 au rassemblement. Dossier des rapports non caché : `rapports-vitest/`.
- `lancer.sh --arreter` : `down -v --remove-orphans --timeout 2`.
- Tests : [A-066] (arbre YAML du workflow) et [C-020] (liste blanche) figent ces règles.

## Conséquences
- Risque accepté : les rapports (blobs) sont des artefacts publics pendant 1 jour ; mots de passe de test éphémères, socle détruit en fin de job, scan C-531 par `controle-journaux.yml`.
- Un re-run partiel d'un fragment n'est pas couvert (un échec serait rouge, jamais un faux vert) : à constater sur la branche de preuve et à noter ici.
- Le reste de l'ADR 0034 tient : fragments compose, `lancer.sh`, garde du compose.
- Passer à 4 fragments : copier un job, remplacer `/3` par `/4`, mettre à jour `FRAGMENTS` et le contrôle.
