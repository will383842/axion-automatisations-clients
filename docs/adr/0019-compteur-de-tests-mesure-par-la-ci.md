# ADR 0019 — Compteur de tests mesuré par la CI, empreintes par contrat

## Contexte
`spec/compte-tests.json` et `spec/compte-tests-integration.json` contenaient un seul nombre. Toute PR qui ajoutait un test modifiait la même ligne : deux PR parallèles entraient toujours en conflit, et après chaque fusion les autres PR passaient au rouge (`consigne ≥ origine/main`). `packages/contrats/contrats.sha256`, liste triée unique, produisait le même genre de conflit entre PR de contrats voisines.

## Décision
- Plus aucun total n'est écrit dans le dépôt. Le job `compter-tests` (et la dernière étape de `socle-integration`) mesure lui-même, sur la PR et sur un `git worktree` du commit de base (`HEAD^1`, checkout `fetch-depth: 2`). Le projet principal est compté sur le rapport exécuté (`vitest run`, base comprise) : `vitest list` ignore les tests sautés et « à faire ». Le projet `integration` est compté par `vitest list` des deux côtés.
- Règle par fichier, plus stricte que le total : `compte(PR, fichier) ≥ compte(base, fichier)`. Un échange de tests entre deux fichiers ne passe plus.
- Un fichier supprimé ou renommé compte `0` : il doit être déclaré.
- Règle « listé ≤ rapport, fichier par fichier » : pour chaque fichier, le compte listé ne dépasse pas le compte du rapport exécuté. Un test listé mais non lancé, ou un rapport partiel (fichiers listés absents du rapport), fait échouer la garde (rôle de l'ancienne `verifierConsigne`).
- Une baisse se déclare dans `spec/retraits/<id-fiche>.json` (`fichier`, `avant`, `apres`, `raison`), avec les nombres mesurés exacts. Seule une déclaration ajoutée par le diff `HEAD^1..HEAD` compte. Base non mesurable : la garde échoue.
- Inchangés : `analyserSource` (skip, only, todo, `test.fails`, retry sensible) et `analyserConfig` (retry > 0).
- L'option `--reference` disparaît ; `--projet integration` et `--base-ref` s'ajoutent. `scripts/garde-licences.ts` reçoit les textes exacts des nouvelles commandes et le `fetch-depth: 2`.
- Empreintes de contrats : `packages/contrats/empreintes/c1.sha256` … `c6.sha256` (c5 n'a aucun fichier couvert), même ensemble de fichiers qu'avant (46 lignes au total). Deux PR sur le même contrat entrent encore en conflit : c'est voulu, un changement de contrat demande un ADR et l'accord de l'architecte (CLAUDE.md §5).

## Conséquences
- Deux PR qui ajoutent des tests ne se touchent plus ; la seconde n'a plus à se remettre à jour.
- Filet sur `main` : au `push`, `HEAD^1` est la `main` précédente (fusions par squash) ; deux fusions rapprochées qui passeraient entre les mailles rendent `main` rouge aussitôt.
- Coût : installation de la base (`pnpm install --frozen-lockfile`, qui réutilise le magasin pnpm quand il le peut ; l'option `--offline` est retirée car elle a échoué en CI faute de paquet dans le magasin).
- Hors de cet ADR : regroupement des workflows et mode « PR d'intégration » (PR à part).
- L'accord de l'architecte reste à obtenir pour la partie contrats (CLAUDE.md §5).
