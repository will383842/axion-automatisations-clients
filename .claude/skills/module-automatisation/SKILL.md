---
name: module-automatisation
description: Écrire un module d'automatisation avec defineAutomation (contrat C4 v0), jeu d'essai et migration.
---

# Skill : module d'automatisation
1. Écris d'abord le test rouge `[C-…] …` puis le module avec `defineAutomation` de `packages/sdk-module` (contrat C4 v0).
2. Jeu d'essai de 20 cas (entreprises inventées uniquement), dont les cas limites et les erreurs.
3. Fournis la fonction `migrer` pour passer d'une version de configuration à la suivante.
4. Aucune action automatique hors de la liste `actionsAutomatiquesAutorisees` ; toute autre action attend la validation d'une personne.
5. Le module reste derrière un interrupteur fermé par défaut.
