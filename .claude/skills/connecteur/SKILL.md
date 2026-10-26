---
name: connecteur
description: Écrire un connecteur : interface de famille, garantie d'effet externe, tests sur réponses enregistrées.
---

# Skill : connecteur
1. Implémente l'interface de la famille (messagerie, calendrier, CRM…) définie dans `packages/contrats`.
2. Déclare la garantie d'effet externe : `idempotent_par_cle`, `verifiable_apres_coup` ou `au_plus_une_fois` (les trois de `packages/sdk-module/src/effets.ts` ; « au moins une fois » n'existe pas).
3. Teste sur des réponses enregistrées, jamais sur un vrai service.
4. Jamais de secret, de jeton ni de vrai nom dans une réponse enregistrée : nettoie avant de commiter.
5. Le connecteur reste derrière un interrupteur fermé par défaut.
