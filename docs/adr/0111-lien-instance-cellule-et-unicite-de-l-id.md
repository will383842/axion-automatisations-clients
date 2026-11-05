# 0111 · Lien instance → cellule : unicité de `instances.id`, clé étrangère composite et oracle

Date : 05/11/2026 · Statut : accepte (architecte, 05/11/2026) · Contrat touché : aucun · Migration : aucune dans cette PR

## Contexte
- `instances` a pour clé primaire `(tenant_id, id)` : `id` n'est pas unique seul. L'API de l'exécuteur reçoit un `instanceId` sans `tenant_id` (il ne vient jamais de la requête) et le retrouve par `id`.
- La clé étrangère `instances_cellule_fk` (migration 0018) vers `cellules(code)` répond 23503 pour un code inconnu et réussit pour un code connu : une attribution directe laisse deviner quels codes de cellule existent (oracle).

## Décision
1. PR #170 (aujourd'hui) : resoudreInstance traite zéro ou plusieurs lignes comme introuvable, sans distinction ; la route répond le même 404. Aucune migration d'unicité dans cette PR.
2. Unicité de l'id : option A retenue. Un index unique instances_id_unique sur instances(id) seul est ajouté ; la clé primaire (tenant_id, id) et toutes les clés étrangères composites restent inchangées. Exception écrite et nominative à la règle toute unicité commence par tenant_id (T2-52), valable pour instances.id seulement, parce que (a) la route de l'exécuteur ne connaît que l'instanceId signé et lit le tenant_id en base, jamais dans la requête, (b) l'id est un UUID tiré par la base. L'option B (table de correspondance id -> tenant_id) est écartée : sa clé serait aussi l'id seul, elle ajoute une double écriture à synchroniser et ne ferme pas l'oracle.
3. Condition de l'exception (anti-oracle) : instances.id reçoit DEFAULT gen_random_uuid() ; le droit INSERT de console_app sur instances devient un droit par colonne qui EXCLUT id (relecture par RETURNING id) ; console_app n'a aucun droit UPDATE sur id ; la migration vérifie l'absence de doublons et échoue sans rien modifier s'il y en a.
4. Oracle de la clé étrangère de cellule : attribution par une fonction SQL réservée à l'équipe (CREATE FUNCTION, REVOKE ALL FROM PUBLIC, SET search_path = pg_catalog, pg_temp, empreinte dans scripts/garde-migrations-fonctions.json), même erreur que le code existe ou non ; le droit d'écrire cellule_code est retiré à console_app.
5. Les points 2, 3 et 4 sont livrés par T2-52 dans une seule migration de durcissement ; l'API de l'exécuteur (EXECUTEUR_API_OUVERTE) ne s'ouvre pas avant cette migration.

## Conséquences
- Tranché : option A. Les points 2, 3 et 4 sont portés par la fiche T2-52 (propriétaire des migrations de durcissement du lot 2) ; leurs critères de test sont dans `spec/preuves.md` (`T4-21-dette-instances-id-unique`, `T4-21-dette-fk-cellule-oracle-reste`).
- Tant qu'ils ne sont pas livrés, la route reste sûre : deux lignes pour un même `id` donnent 404.
