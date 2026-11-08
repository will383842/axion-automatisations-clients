# 0145 · Élargissement d'une contrainte CHECK (exception fermée de la garde des migrations)

Date : 08/11/2026 · Statut : accepté (décision de l'architecte du 08/11/2026, D3-e) ; appliqué par T7-02c, ou par la première fiche qui enregistre une période de 2 à 11 mois · Contrat touché : aucun · Migration : une migration `console` (prochain libre au verrou), plus l'exception dans `scripts/garde-migrations.ts` · S'appuie sur : règle 6 des routines (aucune destruction, numéros jamais réutilisés), ADR 0146 (période libre de 1 à 12 mois)

## Contexte
- Les contraintes `abonnements_periode_valide`, `phases_plan_periode_valide` et `plans_commerciaux_periode_valide` (migration 0008) n'admettent que 1, 6 ou 12 mois.
- T7-29 élargit C1 à une période de 1 à 12 mois (ADR 0146). Si la console enregistre un jour une période de 3 mois, l'INSERT échouera.
- La garde des migrations refuse `DROP CONSTRAINT`, même en phase « contracter » (`scripts/garde-migrations.ts`).

## Décision
Une migration `console` peut supprimer une contrainte CHECK, et **seulement** aux quatre conditions suivantes :
1. le nom de la contrainte figure dans une liste fermée, `scripts/garde-migrations-contraintes.json`, sur le modèle de `garde-migrations-fonctions.json` ;
2. la même migration ajoute **d'abord** une contrainte **strictement plus large** (`NOT VALID`, puis `VALIDATE`) ;
3. aucune autre clause DROP ne figure dans le fichier ;
4. un test prouve que toute ligne valide sous l'ancienne contrainte l'est sous la nouvelle.

La liste fermée ne contient au départ que les trois contraintes de période ci-dessus ; la nouvelle borne est 1 à 12 mois. Une borne au-delà de 12 mois est **à décider par Williams** et demanderait une autre révision.

## Options écartées
- **Lever `DROP CONSTRAINT` en contraction** : ouvre la suppression de toute contrainte, dont celles qui protègent l'argent.
- **Laisser l'ancienne contrainte et en ajouter une seconde** : impossible, l'ancienne refuse déjà 2 à 11.
- **Nouvelle colonne de période** : deux colonnes pour une même notion (refusé par D3-b).

## Conséquences
- Compatible avec l'image N-1, qui n'écrit que 1, 6 ou 12.
- Cette migration **ne bloque pas** T7-02a ni T7-02b. Elle doit être fusionnée avant toute fiche qui enregistre une période de 2 à 11 mois (T7-31 et T7-32).
- La fiche qui l'applique ajoute à ses fichiers autorisés `scripts/garde-migrations.ts`, `scripts/garde-migrations.test.ts` et `scripts/garde-migrations-contraintes.json`.

## Critères de test
- `[LOT7-tables] DROP CONSTRAINT d'un nom hors de la liste fermée → refus de la garde`
- `[LOT7-tables] DROP CONSTRAINT sans contrainte plus large ajoutée avant dans le même fichier → refus`
- `[LOT7-tables] un autre DROP dans le même fichier → refus`
- `[LOT7-tables] toute période 1, 6 ou 12 valide sous l'ancienne contrainte l'est sous la nouvelle ; 0 et 13 restent refusés`
