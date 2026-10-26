# 0024 · Le code d'erreur `reauthentification_requise` dans `packages/contrats`

Date : 26/10/2026 · Statut : **proposé** (en attente de l'accord de l'architecte ; aucun contrat n'est modifié par cette PR)

## Contexte
Une action sensible (secrets, publication d'une version, remboursement) exige une connexion de moins de 5 minutes avec double facteur (C-003). Le crochet `apps/api/src/auth/exiger-reauthentification.ts` répond alors `401` avec le code `reauthentification_requise`, et la console renvoie vers Keycloak avec `max_age=0`.
Ce code n'est pas dans `packages/contrats` : la réponse suit le format commun des erreurs, mais la liste des codes ne le connaît pas. Un client de l'API ne peut donc pas le tester contre le contrat.

## Proposition
Ajouter `reauthentification_requise` (statut 401) à la liste des codes d'erreur du contrat concerné, sur le modèle de `signature_invalide`. C'est un changement de contrat : il demande l'accord de l'architecte (CLAUDE.md, section 5).

## Ce que cette PR ne fait pas
- Elle ne touche à aucun fichier de `packages/contrats`.
- Le code reste envoyé tel quel par l'API en attendant la décision ; les tests de la PR le vérifient sur la réponse de l'API, pas sur le contrat.

## Conséquences si accepté
- Une PR de contrat ajoute le code et met à jour les empreintes de contrat (ADR 0019).
- Si refusé, la réponse reprend un code existant et la console reconnaît la réauthentification par un autre signal.
