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
Une migration ne fait qu'ajouter (colonne, table, index). Le code accepte les versions N et N-1 : le service des données lit `public.version_structure` de la base et choisit la variante de la requête (`variantes: [{ depuis, sql }]`) ; version illisible = variante la plus ancienne.
La suppression vient plus tard, dans un fichier dont la **première ligne** est `-- phase: contracter`. C'est la seule exception à « pas de DROP » (garde `scripts/garde-migrations.ts`), et seulement dans `apps/*/drizzle-cli/` : elle lève `DROP TABLE`, `DROP INDEX` et `ALTER TABLE … DROP COLUMN`, sans `CASCADE`, rien d'autre (ni `DROP POLICY`, `SCHEMA`, `FUNCTION`, `TRIGGER`, `DROP CONSTRAINT`, ni RENAME, ni TRUNCATE, ni DROP de rôle ou de base, ni fonction). Une migration de module ne contracte jamais.
Un fichier contracter n'est appliqué que si les trois conditions sont vraies (`regles-versions.ts`) : l'interrupteur `CONTRACTER_OUVERT` est ouvert (fermé par défaut, même en production, Will seul l'ouvre au lot 8a) ; 100 % des bases du registre sont en N, quarantaine comprise ; le code déployé est en N+1 (`VERSION_STRUCTURE_CODE`). `migrerBase` prend la décision lui-même, par un lecteur d'état qui relit TOUTES les bases du registre (gelées ou en création comprises) : un booléen fourni par l'appelant ne suffit plus. De même `planifierVagues` refuse la version N+1 tant qu'une base reste en N-1. Chaque contracter appliqué est tracé au journal d'audit par l'appelant. La migration d'une base fermée n'est pas livrée par les vagues (dette de T2-52).

## Vagues (`apps/api/src/donnees/vagues.ts`)
- Ordre : **recette**, **bases internes AXION** (deux listes de configuration), **canari** (5 % des autres bases actives, arrondi au supérieur, minimum une), puis **lots de 50** (ordre des noms). Seules les bases actives encore en retard sont migrées.
- Canari tiré avec une graine, écrite au journal avant la première vague. Rejouer une version relit la graine : en demander une autre est refusé, les vagues se rejouent à l'identique.
- `deroulerVague` migre 5 bases en parallèle au plus, par `migrerBase`, sur les noms relus dans `bases_client` (une vague falsifiée est refusée avant toute migration).
- Une base en échec reste dans sa version précédente : `versions_structure` reçoit `quarantaine`, l'alerte `migration_echec` part (identifiant console du client, jamais son nom), la vague continue. Aucun texte d'erreur n'est gardé.
- Si plus de 2 % d'une vague échoue (seuil configurable), les vagues suivantes ne partent pas.
- Reprise : après correction, `planifierVagues` avec la même version rend les mêmes vagues, réduites aux bases encore en retard.
- La migration N+1 est refusée tant qu'une base reste en N-1. En production (`NODE_ENV=production`), `migrerBase` refuse une cible plus basse que la version appliquée : le retour arrière est celui du code seulement.

## Reste à faire (dettes, propriétaire T2-34)
Les objets du modèle appartiennent à `modele_proprietaire`. Après `CREATE DATABASE … TEMPLATE`, la recette doit les passer au propriétaire du client (`REASSIGN OWNED BY modele_proprietaire TO cli_<id>_proprietaire`) avant `migrerBase`, sinon la pose des droits échoue avec un message clair.
