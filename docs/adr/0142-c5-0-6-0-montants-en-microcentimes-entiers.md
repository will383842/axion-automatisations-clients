# 0142 · C5 0.6.0 : montants en `_microcentimes` (entiers)

Date : 08/11/2026 · Statut : accepté (décision de l'architecte du 08/11/2026, D3-d) ; appliqué par T7-02a · Contrat touché : C5 (0.5.0 → 0.6.0) · Migration : aucune (la première colonne concernée vient avec T7-02a) · S'appuie sur : ADR 0031 (C5 non gelé), 0139 (registres par fiche)

## Contexte
- Le lot 7 enregistre des prix unitaires d'IA trop petits pour le centime (prix par million d'unités consommées). Il les range dans des colonnes `…_microcentimes`.
- La règle C5 actuelle (`packages/contrats/src/c5/invariants.ts`, `argent_non_entier`) ne refuse un type non entier que si le nom finit par `_centimes`. Or `…_microcentimes` ne finit pas par `_centimes` : une colonne `real` de ce nom ne serait attrapée que par le motif MONTANT, et seulement si son nom contient « prix ».
- C5 n'est **pas gelé** (ADR 0031, `packages/contrats/VERSION` : « Non gelés : C4 et C5 ») : une révision est permise par ADR.

## Décision
1. **Règle C5 0.6.0** : tout nom de colonne qui finit par `centimes` (donc aussi `_microcentimes`) exige un type entier ; un nom qui finit par `_microcentimes` exige `bigint`.
2. **Unité** : 1 microcentime = 10⁻⁶ centime.
3. **Conversion** vers des centimes : par **une seule fonction TypeScript**, en `BigInt`, au moment de produire une ligne de facture. Jamais en base, jamais en `Number`.
4. **Arrondi** : le sens (au plus proche ou au-dessus) et le niveau (par ligne de facture ou sur le total du mois) changent le montant facturé : ils sont **à décider par Williams**. Tant qu'il n'a pas confirmé, l'arrondi est un paramètre nommé de la fonction de conversion, sans valeur par défaut retenue, et testé dans les deux sens. Recommandation technique, soumise à sa confirmation : au centime le plus proche, demi au-dessus, une seule fois par ligne de facture, jamais par appel.
5. **Nom** de la colonne du prix d'un modèle d'IA : `prix_million_unites_microcentimes` (on évite « jetons », que la garde des secrets refuse).
6. **Version** : `c5=0.6.0` dans `packages/contrats/VERSION`, une entrée dans `CHANGELOG.md`, `contrats.sha256` et `empreintes/c5.sha256` régénérés.

## Options écartées
- **Garder la règle 0.5.0** et compter sur le motif MONTANT : une colonne `…_microcentimes` en `real` dont le nom ne contient pas « prix » passerait.
- **Ranger les prix d'IA en `numeric`** : un type décimal en base ouvre la porte aux calculs en base et aux arrondis implicites.
- **Convertir en base** (fonction SQL ou colonne générée) : l'arrondi deviendrait invisible au code qui produit la facture, et ajouterait une fonction à la liste fermée.

## Conséquences
- T7-02a pose la règle (fichiers ajoutés à sa fiche : `packages/contrats/src/c5/invariants.ts`, `VERSION`, `CHANGELOG.md`, `contrats.sha256`, `empreintes/c5.sha256`) et sa première colonne `bigint`.
- Toute migration existante reste conforme : aucune colonne actuelle ne finit par `microcentimes`.
- Audit : zone argent, relecture par un auditeur argent avant fusion.

## Critères de test (fiche T7-02a)
- `[LOT7-tables] une colonne …_microcentimes en integer, numeric ou real est refusée (C5 0.6.0)`
- `[LOT7-tables] une colonne …_microcentimes en bigint est acceptée`
- `[LOT7-tables] la conversion microcentimes → centimes se fait en BigInt, arrondi paramétré, testé dans les deux sens`
