# 0111 · Lien instance → cellule : unicité de `instances.id`, clé étrangère composite et oracle

Date : 05/11/2026 · Statut : proposé (rédigé par la routine de la PR T4-21 2/2 sur consigne de l'orchestrateur ; décision de l'architecte à confirmer avant toute migration) · Contrat touché : aucun · Migration : aucune dans cette PR

## Contexte
- `instances` a pour clé primaire `(tenant_id, id)` : `id` n'est pas unique seul. L'API de l'exécuteur reçoit un `instanceId` sans `tenant_id` (il ne vient jamais de la requête) et le retrouve par `id`.
- La clé étrangère `instances_cellule_fk` (migration 0018) vers `cellules(code)` répond 23503 pour un code inconnu et réussit pour un code connu : une attribution directe laisse deviner quels codes de cellule existent (oracle).

## Décision
1. **Aujourd'hui (PR 2/2)** : `resoudreInstance` traite zéro ou plusieurs lignes comme « introuvable », sans distinction ; la route répond le même 404. Aucun index unique n'est ajouté ici (aucune migration dans cette PR).
2. **Cible** : un index unique sur `instances(id)` seul, ajouté par la migration de T2-52 (toute unicité y commence par `tenant_id` : l'exception est à valider par l'architecte, l'`id` étant un UUID tiré au hasard). Alternative notée : clé étrangère composite `(tenant_id, id)` des tables liées et résolution par `(tenant_id, id)` après lecture du `tenant_id` dans une table de correspondance réservée à l'équipe.
3. **Oracle** : l'attribution d'une cellule passe par une fonction SQL réservée à l'équipe (CREATE FUNCTION, REVOKE ALL FROM PUBLIC, `search_path` fixé, empreinte dans la garde des fonctions) qui rend la même erreur que le code existe ou non ; le droit d'écrire `cellule_code` est retiré à `console_app`. Côté route, la réponse est déjà identique (cellule inconnue = même 401 qu'une signature fausse, `[C-016]`).

## Conséquences
- Les points 2 et 3 sont portés par la fiche T2-52 (propriétaire des migrations de durcissement du lot 2) ; leurs critères de test sont dans `spec/preuves.md` (`T4-21-dette-instances-id-unique`, `T4-21-dette-fk-cellule-oracle-reste`).
- Tant qu'ils ne sont pas livrés, la route reste sûre : deux lignes pour un même `id` donnent 404.
