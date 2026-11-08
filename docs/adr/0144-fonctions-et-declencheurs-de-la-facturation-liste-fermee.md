# 0144 · Fonctions et déclencheurs de la facturation (liste fermée)

Date : 08/11/2026 · Statut : accepté (décision de l'architecte du 08/11/2026, D4) ; appliqué par T7-02a, b et c · Contrat touché : aucun · Migration : celles de T7-02 (`console` 0042 et suivantes, prochain libre au verrou) · S'appuie sur : ADR 0126 et 0141 (politiques plutôt que déclencheurs), 0135 (version immuable d'une grille), règle 6 des routines (une fonction SQL = CREATE + REVOKE ALL FROM PUBLIC + SET search_path + empreinte)

## Contexte
- E2 : la fiche T7-02 demandait `changer_plafond_droits` (`SECURITY DEFINER`), un déclencheur de verrou du plafond des droits délégués, et des déclencheurs qui refusent un UPDATE ou un DELETE hors de colonnes permises sur `ajustements_volume`, `droits_abonnement_delegues` et `prix_modeles_ia`. Chaque fonction doit entrer dans `scripts/garde-migrations-fonctions.json`.
- E3 : aucune fiche ne crée `propositions_facturation`.
- Les ADR 0126 et 0141 ont déjà écarté un déclencheur « pour un besoin que deux politiques couvrent ».

## Décision
1. **Refus d'UPDATE et de DELETE sans déclencheur**, partout où c'est possible :
   - `prix_modeles_ia` : `GRANT INSERT` seul, pour `console_equipe` ; ni UPDATE ni DELETE : une ligne est une version, comme `grilles_prix` (ADR 0135) ;
   - `ajustements_volume` et `droits_abonnement_delegues` : aucun `GRANT DELETE` ; `GRANT UPDATE` par colonne seulement (`annule_le, annule_par, annule_motif`, ou `retire_le, motif`) ; une politique restrictive « à sens unique » : `USING (retire_le IS NULL) WITH CHECK (retire_le IS NOT NULL AND …)`, comme `envoi_une_seule_fois` de 0041 (ADR 0141).
2. **Liste fermée de deux fonctions**, chacune avec CREATE + `REVOKE ALL FROM PUBLIC` + `SET search_path = pg_catalog, pg_temp` + une empreinte dans `scripts/garde-migrations-fonctions.json` :
   1. `changer_plafond_droits(organisation uuid, valeur int, reference_demande text)`, `SECURITY DEFINER`, `EXECUTE` à `console_equipe` seulement ; elle écrit le journal d'audit par l'`audit_ecrire` existant ;
   2. `verifier_plafond_droits()`, fonction de déclencheur `BEFORE INSERT` sur `droits_abonnement_delegues`, `SECURITY DEFINER`. Elle pose `SELECT … FOR UPDATE` sur la ligne `organisations` qui porte le plafond ; ce verrou exige un droit UPDATE que le rôle du portail n'a pas, d'où `SECURITY DEFINER`.
3. **Repli**, seulement si l'audit de T7-02b démontre qu'une politique ne suffit pas (protection contre le propriétaire de la table) : **une seule** fonction générique `refuser_hors_colonnes()` qui lit `TG_ARGV`, jamais une fonction par table.
4. **E3** : T7-02c crée `propositions_facturation`, avec la référence d'abonnement. Sa colonne `type` est une énumération : `acompte_attendu`, `jalon_a_appeler`, `reclamation_penalites`, `prelevement_echoue`.
5. **Plafond des droits délégués** : la colonne et son `CHECK (… >= 1)` sont techniques et décidés ici. **La valeur du plafond (et sa valeur par défaut) est à décider par Williams** ; la valeur par défaut posée par la migration reste provisoire.

## Options écartées
- **Une fonction par déclencheur** : trois ou quatre fonctions de plus dans la liste fermée, pour des refus que des droits par colonne et des politiques couvrent.
- **Une fonction générique d'emblée** : gardée en repli, si l'audit montre qu'elle est nécessaire.

## Conséquences
- `scripts/garde-migrations-fonctions.json` est autorisé dans T7-02 pour ces **deux entrées seulement** ; un test vérifie que le fichier ne gagne que ces deux clés (trois si le repli est démontré par l'audit).
- `role_invitation` sert au portail seulement : `droits_abonnement_delegues` cite un utilisateur du portail, jamais `role_membre_equipe` (K5).
- Audit : zone argent et sécurité, 2 tours, avant fusion.

## Critères de test (fiche T7-02)
- `[LOT7-tables] garde-migrations-fonctions.json ne gagne que changer_plafond_droits et verifier_plafond_droits`
- `[LOT7-tables] console_app ne peut ni supprimer ni réécrire une ligne d'ajustements_volume ou de droits_abonnement_delegues hors des colonnes permises` (intégration)
- `[LOT7-tables] une ligne de prix_modeles_ia ne se modifie ni ne se supprime` (intégration)
- `[LOT7-tables] deux INSERT simultanés de droits délégués ne dépassent pas le plafond` (intégration)
- `[LOT7-tables] propositions_facturation existe et porte la référence d'abonnement`
