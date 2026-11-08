# 0133 · Recherche globale de la console

Date : 07/11/2026 · Statut : proposé (T3-09a), à accepter par l'architecte · Contrat touché : aucun · Migration : aucune · ADR 0063 rendu (jamais utilisé), 0133 pris · S'appuie sur : ADR 0111 (rôle console_equipe), T3-06 (droits et portée)

## Contexte
- La console doit trouver un client, un contact, une facture, une demande ou une instance depuis un seul champ (B-074, B-099), sans jamais montrer un client hors de la portée du membre (B-126) et sans lire une base de client (B-070).
- Les colonnes téléphone des contacts et numéro des demandes n'existent pas : une migration est hors de cette tâche.

## Décision
1. Route GET /api/console/v1/recherche, lecture seule, derrière une option absente par défaut de construireServeur et un interrupteur `ouvert()` fermé par défaut. Paramètres en liste fermée : `q` (2 à 100 caractères, sans caractère de contrôle) et `limite` (1 à 20, défaut 5, par groupe).
2. Ordre des contrôles : porte, équipe, terme, membre actif avec le droit « lire », débit par membre (429 et Retry-After), portée, dépôt. Aucune lecture avant la fin de ces contrôles.
3. La portée vient du membre seulement : dirigeant ou « * » = tous les clients ; sinon ses identifiants au motif UUID ; liste vide ou rôle inconnu = aucune lecture (échec fermé).
4. Registre fermé de sources (client, contact, facture, demande, instance). T3-40 y ajoutera automatisation et préréglage, une entrée chacune.
5. Dépôt SQL : le pool console_equipe seul, une transaction en lecture seule, toujours cinq requêtes au texte constant ; portée et exclusion de l'organisation réservée de la plateforme dans le WHERE, avant le LIMIT ; LIKE échappé avec ESCAPE ; le terme n'est comparé à l'identifiant d'une demande que s'il a la forme d'un UUID.
6. Réponse en liste blanche : aucun montant, jamais la référence de texte d'une demande ; le terme n'est jamais journalisé.
7. Un second filtre du service écarte toute ligne hors portée rendue par erreur par le dépôt (ceinture, avec un avertissement sans valeur).

## Limites écrites
- Le temps d'exécution de PostgreSQL n'est pas rendu constant.
- Le débit est un compteur par processus de l'API.
- Pas d'index trigramme : parcours séquentiel, à mesurer à 5 000 clients (B-298).
- Le refus d'un membre n'est pas tracé : le mode « globale filtrée » de exiger-droit.ts reste à créer (escalade E1 de l'architecte).

## Options écartées
- Filtrer la portée dans le service après la limite : le nombre de résultats trahirait des clients hors portée.
- Réutiliser exigerDroit en mode « globale » : il refuse tout second administrateur dont la portée ne contient pas « * ».
