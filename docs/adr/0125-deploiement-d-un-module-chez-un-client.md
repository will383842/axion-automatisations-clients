# 0125 · Déploiement d'un module chez un client

Date : 07/11/2026 · Statut : proposé (T4-28a), à accepter par l'architecte · Contrat touché : aucun (deux tables de client ; `TABLES_COMMUNES` inchangée ; C4 et C5 inchangés) · Migration : `0028_deploiement_instances.sql` · S'appuie sur : ADR 0051 (catalogue, `instances_garde`), 0053 (activation), 0054 (configurations), 0111 (instances), 0122 (cycle de vie des versions)

## Contexte
- Une instance (client, automatisation, version, formule, environnement, état) et ses réglages versionnés existent déjà ; la base exige une version publiée et un contrat de sous-traitance pour l'activation.
- Il manque : la preuve d'un test à blanc avant l'activation, le journal des installations et des mises à jour (vagues, quarantaine), et l'unicité d'une instance par client et par automatisation.

## Décision
1. Aucune colonne ajoutée à `instances`. Index unique partiel `(tenant_id, automatisation_id, environnement)` : une instance par client, automatisation et environnement. La fiche dit « (client, automatisation) » : l'environnement est ajouté pour garder l'instance de test à côté de la production, prévue par le lot 2.
2. Table `tests_a_blanc`, par client, en ajout seul : un test terminé par ligne, lié à l'instance, à la version et à la configuration de cette instance (clé étrangère à trois colonnes) ; compteurs et code seulement ; un test réussi n'a aucun envoi.
3. Table `deploiements_instance`, par client, en ajout seul : version de départ, version cible, configuration migrée, résultat (`resultat_version` réutilisée), cause (un code), vague.
4. Activation : la dernière ligne de `tests_a_blanc` pour la version courante et la configuration active doit être « reussi » (garde d'activation dans le code, à côté des gardes de paiement et de clé d'IA, livrée par T4-28b1). Une instance naît en pause.
5. Mise à jour : la version ne bascule qu'après des réglages migrés valides, des tables à la version cible et un test à blanc réussi de la cible ; sinon l'instance reste sur l'ancienne version et une alerte part (T4-28b2).
6. Les tables d'un module vivent dans `a_<code>` de la base du client, par client et par module : les instances de test et de production d'un même client les partagent ; les migrations de module sont additives et passent par les vagues de T2-38 et par la garde des migrations de module (texte et arbre, aucun `CREATE OR REPLACE`, aucune fonction).
7. Aucune fonction SQL nouvelle, aucune valeur d'énumération ajoutée, aucun déclencheur autre que l'audit. Nom des clés étrangères posés à la main (63 caractères au plus).
8. Les deux index uniques s'ajoutent à des tables du lot 2 (`instances`, `configurations`) : ajout seul. Si des doublons d'instances existent déjà, la création de l'index échoue et la migration s'annule tout entière (échec fermé) ; on ne supprime ni ne fusionne jamais de ligne pour la faire passer : décision de Will.

## Options écartées
- Valeur « en_preparation » dans `etat_instance` : touche l'état voulu de C4 (correspondance), la supervision et des tests figés ; « pause » suffit.
- Garde d'activation en base (déclencheur) : une fonction de plus dans la liste fermée ; la base tient déjà la version publiée et le contrat.
- `CHECK formule = 'abonnement'` : devrait être retiré en V2, or un retrait de contrainte est interdit.
- Une instance par (client, automatisation) sans l'environnement : interdirait l'instance de test prévue par le lot 2.
- Lire le test à blanc dans le journal d'audit : le journal sert à la trace, pas à une règle.

## Conséquences
- T4-51 et T4-54 branchent leurs gardes d'activation sur le même mécanisme.
- T5-39 lit `deploiements_instance` (date de la dernière vague, version active).
- L'exécution à blanc réelle et la migration des réglages dans le bac à sable demandent une révision de C4 (sous-fiche T4-28c, ADR à part).
- Une instance ne peut pas pointer une version pilote (`instances_garde`) : le pilote interne reste à régler avec l'architecte du lot 2.
- Retour arrière : retirer les droits seulement ; aucune donnée n'est détruite.
- Mesure de la garde des colonnes : le motif `{1,64}` des colonnes `code_erreur` et `cause` est compté 65 par `textesSansLimite` (convention « n + 1 ») ; la liste fermée propre à ces tables porte donc 65.
