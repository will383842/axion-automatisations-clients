# 0035 · Isolation des clients par `set_config` à chaque transaction et rôles distincts

Date : 29/10/2026 · Statut : proposé (T1B-02, consigne ce qui est livré au lot 1-A ; relecture de l'architecte du lot demandée) · Contrat touché : aucun

## Contexte
Décision d'architecte n° 5 du sommaire du lot 1-A. L'isolation entre clients repose sur la sécurité par ligne (RLS) de PostgreSQL. Elle ne tient que si le rôle de l'application ne peut ni posséder les tables ni contourner la RLS, et si le client actif ne fuit pas d'une requête à l'autre derrière PgBouncer en mode transaction.

## Décision
- Chaque transaction pose le client actif par `set_config('app.tenant_id', <id>, true)` (le `true` limite la valeur à la transaction). Jamais de réglage de session.
- Trois familles de rôles par base (`ops/socle/postgres/init/02-roles.sql`) : `*_proprietaire` (propriétaire des objets, sans connexion), `*_migration` (agit seulement après `SET ROLE` vers le propriétaire, `NOINHERIT`), `*_app` (l'application).
- `*_app` : `NOBYPASSRLS`, `NOINHERIT`, ne possède rien, aucun droit hérité. Il ne voit que les lignes de son client actif.
- `*_equipe` : rôle distinct, lui aussi `NOBYPASSRLS`, avec des politiques de lecture propres. La console de l'équipe n'emprunte jamais le rôle de l'application.
- Les tables de client sont en `ENABLE` + `FORCE ROW LEVEL SECURITY` (modèle : `ops/socle/postgres/modele-politique-rls.sql`), donc le propriétaire est soumis aux politiques lui aussi.
- Un mot de passe par rôle, tiré d'un secret du socle ; le secret lui-même n'ouvre rien.

## Conséquences
- Oublier le `set_config` donne zéro ligne, pas toutes les lignes.
- Les écritures de migration ou d'amorçage sur une table de client passent par le code qui pose le client actif.
- Les ADR 0040 (unicité et clés étrangères) et 0042 (journal d'audit) s'appuient sur ce socle.

Fiche : T1A-03 (aussi T1A-04 pour le branchement de l'API).
