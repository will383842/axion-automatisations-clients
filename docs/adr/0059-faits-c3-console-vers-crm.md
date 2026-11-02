# 0059 · Faits C3 envoyés de la console au CRM

Date : 02/11/2026 · Statut : proposé (T2-18) · Contrat touché : aucun · Migration : aucune. Cet ADR ne contient aucun prix.

## Contexte
La console envoie au CRM des faits (client créé, statut, résumé du plan, renouvellement proche, impayé, automatisation activée, contrat résilié). Chaque fait est déposé dans la boîte d'envoi, dans la transaction du changement, puis envoyé plus tard.

## Décision
1. **Un fait = un client.** L'émetteur est lié à un client (`tenantId`). Un fait pour un autre client est refusé avec une erreur, avant tout dépôt et toute ligne de journal.
2. **Activation.** Le fait ne part que sur un vrai changement d'état (`UPDATE … AND etat <> 'active'`). Une instance déjà active ne produit rien. La clé d'intention contient le jour (`activation:<instance>:<jour>`), car la boîte d'envoi refuse une intention déjà déposée avec un autre corps. Le jour est pris en base, fuseau Europe/Paris.
3. **Renouvellements.** La tâche de nuit lit une plage (fin après aujourd'hui, au plus à 30 jours), pas une égalité : une nuit manquée ne perd rien. La clé reste `renouvellement:<date de fin>` ; `occurred_at` vient de la date de fin (moins 30 jours), jamais du jour d'exécution, donc le corps est identique d'une nuit à l'autre. Un abonnement dont les plans disent tous « arrêt » n'est pas signalé.
4. **Journal.** La ligne écrite au dépôt dit `en_attente_de_validation` : le dépôt n'existe qu'une fois la transaction validée. Elle ne dit jamais « envoyé ».
5. **`emitted_at`** vaut aujourd'hui la date du changement (comme `occurred_at`), pas l'heure d'envoi réel : le corps doit rester identique au rejeu. L'heure d'envoi réelle appartient à la boîte d'envoi (T2-14).

## Dettes
- **Émetteur facultatif dans `activerInstance`** : un appelant qui l'oublie active sans fait au CRM. Propriétaire : T2-14 (adaptateur de la boîte d'envoi, PR 134). Critère de test : un essai d'intégration de la route d'activation prouve une ligne dans `boite_envoi` ; l'émetteur devient alors obligatoire.
- **Tâche de nuit non planifiée** : la fonction existe, aucun planificateur ne l'appelle. Propriétaire : T2-11 (tâches de nuit). Critère de test : le planificateur appelle `signalerRenouvellementsProches` une fois par client et par nuit, et après une nuit manquée la suivante signale la date.
- **Pas de lien direct abonnement ↔ plan** : l'exclusion des abonnements « arrêt » passe par l'organisation. Propriétaire : T2-52. Critère de test : essai d'intégration (`socle-integration`) avec deux abonnements d'une même organisation, l'un reconduit, l'autre arrêté ; seul le reconduit est signalé.
- **Requête de renouvellement non jouée en base** : seuls le texte et les bornes sont testés. Propriétaire : T2-52. Critère de test : le même essai d'intégration, sur une vraie base.
