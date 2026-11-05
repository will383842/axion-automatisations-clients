# 0111 · Lien instance → cellule : unicité de `instances.id`, clé étrangère composite et oracle

Date : 05/11/2026 · Statut : proposé, EN ATTENTE DE L'ARCHITECTE (la routine ne tranche pas le fond ; aucune migration tant que la décision n'est pas écrite ici) · Contrat touché : aucun · Migration : aucune dans cette PR

## Contexte
- `instances` a pour clé primaire `(tenant_id, id)` : `id` n'est pas unique seul. L'API de l'exécuteur reçoit un `instanceId` sans `tenant_id` (il ne vient jamais de la requête) et le retrouve par `id`.
- La clé étrangère `instances_cellule_fk` (migration 0018) vers `cellules(code)` répond 23503 pour un code inconnu et réussit pour un code connu : une attribution directe laisse deviner quels codes de cellule existent (oracle).

## Décision
1. **Aujourd'hui (PR 2/2)** : `resoudreInstance` traite zéro ou plusieurs lignes comme « introuvable », sans distinction ; la route répond le même 404. Aucun index unique n'est ajouté ici (aucune migration dans cette PR).
2. **Unicité de l'id : décision renvoyée à l'architecte.** La règle de T2-52 veut que toute unicité commence par `tenant_id` ; la route de l'exécuteur, elle, ne connaît que l'`instanceId` (le `tenant_id` est lu côté serveur, jamais pris dans la requête) et doit retrouver l'instance par `id` seul. Question précise : *choisis-tu (A) un index unique sur `instances(id)` seul, exception à la règle car l'`id` est un UUID tiré au hasard, ou (B) de garder `(tenant_id, id)` et de résoudre l'instance par une table de correspondance `id → tenant_id` réservée à l'équipe, avec clés étrangères composites ?* Aucune des deux options n'est retenue ici. Dans les deux cas, l'essai de T2-52 est le même : deux instances de deux clients ne peuvent pas partager le même `id`.
3. **Oracle** : l'attribution d'une cellule passe par une fonction SQL réservée à l'équipe (CREATE FUNCTION, REVOKE ALL FROM PUBLIC, `search_path` fixé, empreinte dans la garde des fonctions) qui rend la même erreur que le code existe ou non ; le droit d'écrire `cellule_code` est retiré à `console_app`. Côté route, la réponse est déjà identique (cellule inconnue = même 401 qu'une signature fausse, `[C-016]`).

## Conséquences
- Les points 2 (après la décision de l'architecte) et 3 sont portés par la fiche T2-52 (propriétaire des migrations de durcissement du lot 2) ; leurs critères de test sont dans `spec/preuves.md` (`T4-21-dette-instances-id-unique`, `T4-21-dette-fk-cellule-oracle-reste`).
- Tant qu'ils ne sont pas livrés, la route reste sûre : deux lignes pour un même `id` donnent 404.
