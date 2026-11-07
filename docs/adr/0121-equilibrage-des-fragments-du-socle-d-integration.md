# 0121 · Équilibrage des fragments du socle d'intégration

Date : 07/11/2026 · Statut : proposé (lot CI, relecture de l'architecte demandée) · Contrat touché : aucun · Complète : ADR 0118 (la partition `--shard`)

## Contexte
L'ADR 0118 découpe `socle-integration` en trois fragments avec `vitest --shard`, qui trie les fichiers par empreinte du chemin. Le nombre de fichiers est équilibré (26, 25, 25), pas la durée : la mesure du 07/11 donne 4:11, 8:08 et 2:48 par fragment, et 10:57 pour l'exécution. Le fragment 2 contient les six fichiers lourds connus.

## Décision
- Trois fragments (`fragment-1` à `fragment-3`, noms `socle-integration-fragment-N`), comme l'ADR 0118, mais équilibrés par durée. Un essai à quatre fragments (run 1145 de la PR 229) a montré qu'un seul fichier, `tests/socle/sauvegardes.int.test.ts`, pèse environ 5 min de tests (fragment le plus long : 7:11) : un 4e fragment ne raccourcit pas le chemin critique, il ajoute un runner. L'objectif « sous 5 min » demande de découper ce fichier (dette ci-dessous), pas d'ajouter des fragments.
- `--shard` disparaît. Chaque fragment reçoit sa variable `FRAGMENT_INTEGRATION: "i/4"` ; `vitest.config.ts` donne alors au projet `integration` la liste exacte de ses fichiers, calculée par `scripts/partition-integration.ts`.
- Partition par poids fixes : glouton (fichier le plus lourd d'abord, dans le fragment le moins chargé), déterministe. Les poids, en secondes déduites des durées par fragment du run 1145 (pas de mesure par fichier), sont dans `ops/socle/poids-integration.json` : six fichiers lourds, les autres valent le poids par défaut. Ce sont des estimations tant que la mesure par fichier (§5 de la mesure) manque ; la liste se révise quand l'écart entre le fragment le plus long et le plus court dépasse 90 s.
- Séparation : `vagues`, `migrer-module` et `isolation-roles` font `CREATE DATABASE … TEMPLATE modele_v1`, qui échoue (« being accessed by other users ») si un autre fichier touche le modèle en même temps ; `grappe` s'y connecte. Le premier essai à poids fixes les avait réunis et `vagues` a échoué (run 1146, fragment 2). Le groupe `separes` de `poids-integration.json` les répartit dans des fragments différents (test [A-066]). C'était une course latente de l'ancien découpage, masquée par la chance de l'empreinte du chemin.
- Garanties conservées : chaque fichier dans un seul fragment, l'union est exactement l'ensemble des `*.int.test.ts` (test [A-066]) ; une valeur de fragment invalide fait échouer (jamais « tout lancer ») ; le compteur du rassembleur détecte tout fichier sans résultat.
- Le contrôle requis reste `socle-integration` : même identifiant, même `name`, `if: always()`, `needs` tous les fragments, refus de tout résultat autre que `success success success`. Les contrôles `socle-integration-fragment-N` ne sont pas requis par la protection de `main`, qui n'est pas modifiée.
- Liste blanche (`scripts/garde-licences.ts`) : les commandes `--shard` sont retirées, remplacées par les trois commandes sans `--shard` en `blob-N-3.json`, et `FRAGMENT_INTEGRATION` rejoint les variables permises.

## Conséquences
- Dette : découper `tests/socle/sauvegardes.int.test.ts` (état partagé et tests séquentiels, délais jusqu'à 30 min) pour passer sous 5 min par fragment. Propriétaire à nommer par le chef d'orchestre.
- Ajouter ou renommer un fichier d'intégration ne demande aucun changement : il prend le poids par défaut. Ajouter un fragment demande de copier un job et de changer `FRAGMENTS_INTEGRATION`, la garde et le contrôle (les tests le vérifient).
- Un poids faux ne fait jamais perdre de test, il déséquilibre seulement la durée.
