# Note de reprise : code de départ du garde-fou et du coût d'IA

Cette branche garde, sans PR, le code retiré de la PR #80 (tâche T1A-18) :
`apps/api/src/passerelle/cout-ia.ts` et son test `cout-ia.test.ts`.

Ce code est un point de départ, pas une solution finie. Deux tâches doivent le reprendre avec leurs propres choix :

- **T4-54** : garde-fou anti-boucle (C-634 à C-638). Risque haut, 2 tours de relecture Opus.
- **T3-36** (C-639) : tableau de coûts.

Choix à refaire par ces tâches :
- pas de valeur par défaut du mode ;
- compteur par (instance, exécution) et par (instance, élément) ;
- fenêtre de temps ;
- isolation par client.

Le tableau d'exemple du code ne contient que des nombres ronds sans rapport avec un vrai prix. Les valeurs de travail restent dans le dépôt privé.
