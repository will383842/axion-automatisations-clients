# 0119 · Tables du portail client dans console

Date : 07/11/2026 · Statut : proposé (brouillon ; accord de l'architecte et audit de sécurité en 2 tours : `relecteur` puis `auditeur-securite`) · Contrat touché : aucun (C1 à C6 inchangés, rien dans `packages/contrats/`) · Migration : `0025_portail.sql` (T6-01a, seule migration du lot 6 pour `console`)

## Contexte
- Le portail a besoin de quelques métadonnées dans `console` : reprise des premiers pas, préférences d'envoi, invitations, accord pour le logo, compteurs d'écrans.
- Le texte écrit par un client (demandes, « Pas correct ? ») ne doit jamais entrer dans `console` : il appartient à la base du client (`cli_<id>`), traitée dans une PR séparée (T6-01b).

## Décision
1. **Cinq tables par client** (`tableClient()`), clé `(tenant_id, id)`, clé étrangère composée vers `organisations`, RLS activée **et forcée**, politique `isolation_client` pour `console_app`, lecture seule pour `console_equipe`, aucun droit pour `console_lecture`, `PUBLIC` sans droit, acteur obligatoire (`app.acteur`) à l'insertion et à la modification. Aucun `DELETE` ni `TRUNCATE` accordé ; `UPDATE` par colonnes seulement.
2. **Aucun texte libre** : chaque colonne `text` est un code ou une référence de forme fermée, longueur au plus 129 caractères (`CHECK` par motif borné). Aucune colonne `json`, `bytea` ni tableau. `demandes` est inchangée (C-604).
3. **Invitations : l'empreinte, jamais le jeton.** La colonne s'appelle `empreinte_invitation` (HMAC-SHA-256 en hexadécimal, 64 caractères, forme imposée par `CHECK`) ; la clé du HMAC reste hors base. L'usage est unique : une invitation qui n'est plus `envoyee` ne change plus (politique restrictive). Expiration au plus 30 jours après la création.
4. **Choix de lecture de l'empreinte (réserve E3 du plan).** `console_app` garde `SELECT` sur `empreinte_invitation` : PostgreSQL exige ce droit pour la citer dans un `WHERE`. Une empreinte HMAC n'est pas le jeton. Voie plus fermée possible : fonction `SECURITY DEFINER accepter_invitation(empreinte)`, qui demande un ADR et la liste fermée de `garde-migrations-fonctions.json` ; **à trancher par l'architecte**.
5. **Audit** (`audit_ecrire`) sur `invitations` et `accords_logo` ; pas sur `progression_premiers_pas`, `preferences_notifications` ni `compteurs_ecrans` (volume, aucune valeur métier).
6. **Limite écrite** (règle 9.4 d'arrêt de l'audit) : la garde des colonnes ne lit pas le contenu des lignes ; un jeton rangé dans une colonne de code existante n'est refusé que par la forme du motif. Dette de contrôle de contenu portée par T6-01.

## Conséquences
- Migration additive : aucun `DROP`, `DELETE`, `TRUNCATE`, `RENAME` ni changement de type ; aucune fonction ; une seule transaction.
- **Retour arrière** (à la main, jamais par `DROP`) : `REVOKE` des droits ajoutés ; les tables restent, vides ou inutilisées.
- Reste : T6-01b (deux tables dans le modèle des bases des clients), bloquée par T4-35 et T2-52d.
