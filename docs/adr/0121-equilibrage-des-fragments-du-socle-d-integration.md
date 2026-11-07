# 0121 · Équilibrage des fragments du socle d'intégration

Date : 07/11/2026 · Statut : proposé (lot CI, relecture de l'architecte demandée) · Contrat touché : aucun · Complète : ADR 0118 (la partition `--shard`)

## Contexte
L'ADR 0118 découpe `socle-integration` en trois fragments avec `vitest --shard`, qui trie les fichiers par empreinte du chemin. Le nombre de fichiers est équilibré (26, 25, 25), pas la durée : la mesure du 07/11 donne 4:11, 8:08 et 2:48 par fragment, et 10:57 pour l'exécution. Le fragment 2 contient les six fichiers lourds connus.

## Décision
- Quatre fragments (`fragment-1` à `fragment-4`, noms `socle-integration-fragment-N`) au lieu de trois, pour viser un fragment le plus long sous 5 minutes (le modèle de la mesure donne 4:22 à 4 fragments, 5:13 à 3).
- `--shard` disparaît. Chaque fragment reçoit sa variable `FRAGMENT_INTEGRATION: "i/4"` ; `vitest.config.ts` donne alors au projet `integration` la liste exacte de ses fichiers, calculée par `scripts/partition-integration.ts`.
- Partition par poids fixes : glouton (fichier le plus lourd d'abord, dans le fragment le moins chargé), déterministe. Les poids, en secondes estimées, sont dans `ops/socle/poids-integration.json` : six fichiers lourds nommés par la mesure, les autres valent le poids par défaut. Ce sont des estimations tant que la mesure par fichier (§5 de la mesure) manque ; la liste se révise quand l'écart entre le fragment le plus long et le plus court dépasse 90 s.
- Garanties conservées : chaque fichier dans un seul fragment, l'union est exactement l'ensemble des `*.int.test.ts` (test [A-066]) ; une valeur de fragment invalide fait échouer (jamais « tout lancer ») ; le compteur du rassembleur détecte tout fichier sans résultat.
- Le contrôle requis reste `socle-integration` : même identifiant, même `name`, `if: always()`, `needs` tous les fragments, refus de tout résultat autre que `success success success success`. Les contrôles `socle-integration-fragment-N` ne sont pas requis par la protection de `main`, qui n'est pas modifiée.
- Liste blanche (`scripts/garde-licences.ts`) : les commandes `--shard` sont retirées, remplacées par les quatre commandes sans `--shard` en `blob-N-4.json`, et `FRAGMENT_INTEGRATION` rejoint les variables permises.

## Conséquences
- Un runner de plus par exécution (surcoût fixe mesuré d'environ 1:50 par fragment) ; la file GitHub est partagée.
- Ajouter ou renommer un fichier d'intégration ne demande aucun changement : il prend le poids par défaut. Ajouter un fragment demande de copier un job et de changer `FRAGMENTS_INTEGRATION`, la garde et le contrôle (les tests le vérifient).
- Un poids faux ne fait jamais perdre de test, il déséquilibre seulement la durée.
