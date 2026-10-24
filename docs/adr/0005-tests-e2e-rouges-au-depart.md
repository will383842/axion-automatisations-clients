# 0005 · Tests de bout en bout « rouges au départ »

Date : 24/10/2026 · Statut : accepté

## Contexte
Les scénarios de bout en bout sont écrits avant le code qui les fait passer. Un test ignoré (`skip`) disparaît des comptes et peut être oublié.

## Décision
Un test de bout en bout encore rouge au départ est écrit avec `test.fails` et une étiquette de lot (le lot qui doit le faire passer), jamais avec `skip`. Quand le lot livre la fonction, `test.fails` devient échec : il faut alors le retirer, ce qui force la mise à jour.

## Conséquences
- Les tests rouges restent comptés et visibles dans le rapport.
- Un scénario qui passe par surprise est signalé au lieu d'être ignoré.
- Le détail est dans la fiche de la tâche T0-21 (dépôt privé).
