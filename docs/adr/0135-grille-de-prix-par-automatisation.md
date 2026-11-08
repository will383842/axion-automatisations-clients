# 0135 · Grille de prix par automatisation

Date : 07/11/2026 · Statut : proposé (T3-31a1), à accepter par l'architecte · Contrat touché : aucun · Migration : aucune · S'appuie sur : ADR 0051 (catalogue commun), 0052 et 0058 (plan commercial, héritage des valeurs), 0115 (historique des grilles)

## Contexte
- `grilles_prix` n'accorde à `console_equipe` que SELECT et INSERT : on ne modifie jamais une grille.
- Les plans lisent la grille la plus récente : `ORDER BY cree_le DESC, id DESC LIMIT 1`. `cree_le` vaut `now()`, soit le début de la transaction.
- Le déclencheur d'audit refuse une écriture de grille sans `app.acteur`. L'historique impose `auteur = app.acteur` (politique restrictive).

## Décision
1. **Une grille est une version immuable.** Écrire une grille = insérer une ligne de `grilles_prix` ; la grille en vigueur est celle que lisent les plans. Aucune autre table n'est touchée : un prix changé ne vaut que pour les plans calculés après. La console ne facture jamais.
2. **Saisie stricte.** Corps fermé : `formules`, trois montants HT en centimes sous forme de chaînes `^(0|[1-9][0-9]{0,11})$` (calculés en `BigInt`, jamais en `Number`), `maintenance_incluse_mois` (entier de 0 à 120), `grille_precedente_id` (UUID ou `null`), `motif` (1 à 500 caractères). Tout autre champ (TVA, TTC, taux) est refusé : la TVA est facturée ailleurs.
3. **Règles, dans cet ordre, sans écriture en cas de refus.** Formule hors énumération : 400. Formule `achat` ou `installation_maintenance` : 422 (V2). Prix mensuel nul : 422 (décision W1, par défaut refusé). Automatisation inconnue : 404 ; archivée : 422. Grille précédente différente de la grille en vigueur : 422 « rechargez-la ». Transaction plus ancienne que la dernière grille (`now() <= cree_le`) : même 422. Grille identique : 422. Pas de code d'erreur nouveau : `regle_metier` avec un message fixe.
4. **Une seule transaction** : `SELECT … FOR NO KEY UPDATE` sur la ligne de l'automatisation (sérialise deux écritures sans bloquer les clés étrangères), lecture de la grille en vigueur, règles, INSERT de la grille, un seul INSERT d'historique (une ligne par champ changé, valeurs relues de la grille précédente ; quatre lignes sans ancienne valeur pour une première grille), lecture du masquage, COMMIT.
5. **Masquage (C-138).** Une condition par défaut valide qui porte `frais_mise_en_place_centimes`, `tarif_mensuel_centimes` ou `maintenance_incluse_mois` l'emporte sur la grille : les réponses listent ces clés dans `masquee_par_defaut`, sans bloquer.
6. **Lecture.** `GET …/grille` (grille en vigueur, `formules_proposees` = formules rangées ∩ {abonnement}) et `GET …/grille/historique?limite=` (1 à 200, défaut 50, `unite` = `centimes` ou `mois`). Les valeurs de l'historique sont des chaînes, y compris pour les mois.
7. **Droits et accès.** Porte fermée par défaut (503), équipe, réauthentification récente (POST), puis `exigerDroit` : `publier_catalogue` (dirigeant seul) pour écrire, `lire` pour lire. Routes « globales » : un second administrateur à portée partielle reçoit 404, même en lecture (échec fermé voulu).
8. **Dépôt injecté.** Le service reçoit `transaction` et `lecture` par ses dépendances (comme T4-27b) ; le branchement de production reste une dette.

## Options écartées
- Surcharge par client pour une automatisation : `conditions_commerciales` n'a pas d'`automatisation_id` ; une condition vaudrait pour toutes les automatisations du client. À trancher par l'architecte (A1), dans T3-31b.
- Modifier la grille en place (UPDATE) : non accordé, et l'historique des plans serait réécrit.
- Montants en nombres JSON : la notation scientifique (`1e3`) est déjà un entier avant la validation.

## Conséquences
- Un changement de formules seul crée une grille sans ligne d'historique (aucune valeur d'énumération ne le porte) : dette.
- La période proposée, les paliers et le volume d'IA n'ont pas de colonne : ils passent dans la révision du 27/10 (T3-31c), avec sa migration.
- L'écran de T4-32 appelle cette API au lieu de créer `prix_catalogue`.
