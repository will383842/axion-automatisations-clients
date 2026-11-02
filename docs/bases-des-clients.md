# Bases des clients : structure, migrations, droits

Chaque client a sa propre base `cli_<id>` sur la grappe « données » (ADR 0046). Elle naît d'un modèle `modele_v<N>`, construit une fois à partir des migrations de `apps/api/drizzle-cli/`. Le schéma Drizzle est dans `apps/api/src/db/schema-cli/`, séparé de celui de la console.

## Structure du modèle
- Schéma `commun` : `etablissements`, `entreprises`, `personnes`, `listes_prospects`, `listes_prospects_personnes`, `exclusions` (empreintes seulement), `index_fichiers` (clé d'objet, empreinte, taille, type ; jamais le fichier).
- E-mails et téléphones : colonnes `bytea` `<champ>_chiffre` (chiffrées par la clé du client, T2-33) et `<champ>_empreinte` (recherche, exactement 32 octets). Les textes libres (prénom, type de contenu…) sont bornés à 500 caractères.
- `etablissement_id` est obligatoire sur `personnes`, `listes_prospects` et `index_fichiers`. Ce n'est pas une RLS : le filtre par établissement est imposé par le service des données (T2-37).
- Schéma `trace` : `evenements` (qui, quoi : `import`, `modification` ou `export`, objet, quand), en ajout seul : un déclencheur refuse UPDATE, DELETE et TRUNCATE.
- `public.version_structure` : une ligne par migration appliquée, avec l'empreinte du fichier. C'est le journal des migrations de la base.
- Les schémas `a_<code>` ne sont pas dans le modèle : ils viennent des migrations des modules, appliquées par le provisionnement (T2-35).

## Qui peut quoi
- `cli_<id>_proprietaire` (sans connexion) possède la base, les schémas, `trace` et `version_structure` ; les migrations passent par lui.
- `cli_<id>_app` lit et écrit `commun` (aucun DELETE accordé nulle part ; `exclusions` en ajout seul : ni UPDATE ni DELETE, une opposition ne s'efface jamais), insère dans `trace`, lit `version_structure`. Pour sortir quelqu'un d'une liste, on marque `retire_le` sur `listes_prospects_personnes` : on ne supprime pas.
- `cli_<id>_lecture` lit `commun`, `trace` et `version_structure`.
- Aucun des deux ne peut changer la structure ni la trace.

## Outil de migration (`apps/api/src/donnees/migrer-base.ts`)
- `migrerBase(nomBase, versionCible, { url })` : refuse tout rôle `_app`, `_lecture` ou `_equipe`, et PgBouncer ; prend l'identité du propriétaire ; applique dans l'ordre les migrations manquantes (une transaction chacune) ; écrit `version_structure` ; pose les droits ci-dessus et vérifie qu'ils sont bien là.
- `construireModele(N, { url })` : crée `modele_v<N>` (propriétaire `modele_proprietaire`), y applique toutes les migrations, puis le marque `IS_TEMPLATE` et `ALLOW_CONNECTIONS false`. `CONNECT` est retiré à tout le monde dès la création, et la dernière version est notée en commentaire de la base. Il refuse si la base existe, il ne détruit rien.
- Une migration déjà appliquée dont le fichier a changé, un trou dans les versions ou une version cible inconnue sont refusés.
- La garde `scripts/garde-migrations.ts` lit aussi `apps/*/drizzle-cli/` : aucun DROP, RENAME ni changement de type.

## Étendre puis contracter
Une nouvelle version n'enlève rien : on ajoute d'abord (colonne, table), on bascule le code, et la suppression vient dans une version ultérieure, par une procédure d'équipe hors des migrations ordinaires (détail en T2-38).

## Reste à faire (dettes, propriétaire T2-34)
Les objets du modèle appartiennent à `modele_proprietaire`. Après `CREATE DATABASE … TEMPLATE`, la recette doit les passer au propriétaire du client (`REASSIGN OWNED BY modele_proprietaire TO cli_<id>_proprietaire`) avant `migrerBase`, sinon la pose des droits échoue avec un message clair.
