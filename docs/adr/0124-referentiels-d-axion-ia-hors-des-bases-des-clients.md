# 0124 · Référentiels d'AXION IA hors des bases des clients

Date : 08/11/2026 · Statut : accepté sur le fond (décision de l'architecte du 08/11/2026, D5) ; en vigueur à la fusion de l'étape 1 de T2-50 ; la section « Question juridique » reste ouverte · Contrat touché : aucun (C5 inchangé : la base `referentiels` n'est pas dans la chaîne de `console`) · Migration : nouvelle chaîne `apps/api/drizzle-referentiels/` (base à part, première migration 0000), et une migration additive du modèle des bases des clients (`drizzle-cli`, colonnes d'origine, sous-PR T2-50c) · Modifie : la garde de minimisation (T2-47), par une exception fermée et nommée

## Contexte
- Il existait deux sortes de données : les données de travail d'un client (sa base `cli_<id>`) et les métadonnées de l'équipe (`console`, `moteur`).
- Il en faut une troisième : des **référentiels** qu'AXION IA possède et met à disposition de plusieurs clients. Ce référentiel est **une base de prospects**, par secteur, et non un annuaire d'entreprises : il ne sert jamais à l'autocomplétion d'une entreprise, qui reste à l'API publique.
- Les ranger dans `console` mélangerait des données personnelles et des métadonnées, contre la garde de minimisation. Les ranger dans une base client les rendrait lisibles par un seul client et copiées N fois sans contrôle.

## Décision
1. **Une base à part** `referentiels`, sur la grappe « données », hors de `console`, de `moteur` et de toute base `cli_<id>`. Sa recette : `ops/socle/donnees/referentiels.sql`, sur le modèle de T2-31 (`REVOKE CONNECT … FROM PUBLIC`).
2. **Rôles** :
   - `ref_proprietaire` : NOLOGIN, propriétaire des objets ;
   - `ref_equipe` : import et publication par l'équipe, jamais de DELETE ni de TRUNCATE ;
   - `ref_extraction` : lecture seule, utilisé par le service des données de l'API seulement.
   Aucun rôle `cli_*`, aucun rôle de l'exécuteur et aucun rôle de la console (`console_app`, `console_lecture`) n'a CONNECT sur cette base. Un module ne la lit **jamais** : le port `donnees` ne connaît que la base du client de l'exécution (ADR 0109, 0112, 0113).
3. **Versions immuables** : un référentiel a des versions `brouillon` → `publiee` → `retiree`. Une version publiée ne change plus. Un déclencheur refuse tout UPDATE de ses fiches et de son empreinte ; sa fonction est inscrite à la garde des fonctions (règle 6). `retiree` interdit toute nouvelle extraction, mais ne retire rien chez les clients.
4. **Droits par (client, référentiel, version)** : début, fin et plafond d'extraction. Sans droit en cours, l'extraction est refusée.
5. **Extraction tracée** : le service des données vérifie le droit, le plafond et les trois listes d'exclusion (celle du client, celle de la plateforme C-633, celle du référentiel). Il **copie** ensuite les fiches retenues dans `commun.personnes` / `commun.entreprises` de la base du client, avec leur origine (référentiel, version, date, auteur). Il trace l'extraction (client, version, nombre, auteur, corrélation). Aucune autre donnée ne quitte `referentiels`.
6. **Rien ne remonte** : les notes, statuts, messages et listes du client restent dans sa base. La seule information qui remonte est l'empreinte d'une adresse désinscrite (C-627), versée à `exclusions_referentiel`, avec la même normalisation que la liste d'exclusion (T2-02).
7. **Garde de minimisation** : une exception fermée et nommée, `referentiels`, est écrite dans `scripts/garde-minimisation.ts` avec sa raison. Tout autre contenu de travail hors des bases des clients reste interdit.
8. **Colonnes d'origine** chez le client : ajout additif au modèle des bases des clients (colonnes nullables `origine_referentiel`, `origine_version`, `origine_le`, `origine_auteur` sur `commun.personnes` et `commun.entreprises`), appliqué par les vagues de T2-38 (sous-PR T2-50c, décision D7). Une fiche saisie par le client garde une origine nulle.
9. **Import et publication** par l'équipe seulement : import tracé (file d'import de T4-37) ; publication par geste tracé, avec réauthentification.

## Options écartées
- **Schéma `referentiels` dans `console`** : une seule base à sauvegarder, mais des données personnelles dans la base des métadonnées. La garde de minimisation devrait s'ouvrir largement.
- **Lecture directe du référentiel par le client** (vue, rôle de lecture partagé) : un rôle lisible par plusieurs clients est un chemin entre clients. Le cloisonnement « une base par client » ne tiendrait plus.
- **Référence au lieu d'une copie** : le client dépendrait d'AXION IA pour lire ses propres prospects, et le retrait d'une version effacerait son travail.

## Conséquences
- Une 4e chaîne de migrations (`drizzle-referentiels`), à part, avec son propre journal. Elle ne prend jamais le verrou de `console`.
- La matrice des chemins (C-536) gagne un chemin : API → `referentiels` en lecture, par `ref_extraction`.
- La sauvegarde et la supervision de la grappe « données » couvrent la nouvelle base. Elle n'appartient à aucun client : elle est hors des sauvegardes par client.
- Les colonnes d'origine sont déclarées dans le fragment `cli` de T2-50c (`apps/api/src/db/colonnes/fragments/t2-50c.ts`, registre des colonnes, ADR 0139), comme textes bornés sans donnée personnelle.
- Le sort d'une fiche copiée à la fin d'un contrat (décision D6) n'est **pas** tranché ici : il revient à Williams et au juriste.

## Question juridique (ouverte)
La base légale de la mise à disposition et l'information des personnes dont les données sont copiées chez un client sont **à décider par Williams** avec le juriste, par écrit. Accepter cet ADR ne tranche pas ce point. L'interrupteur `referentiels.extraction` reste **fermé par défaut** jusqu'à leur réponse écrite. Le code de l'étape 1 (base, rôles, versions) peut partir fermé.

## Critères de test (fiche T2-50)
- `[A-412] @isolation aucun rôle d'un client ne se connecte à la base referentiels` (intégration)
- `[A-412] sans droit (client × référentiel × version), l'extraction est refusée`
- `[A-412] une version publiée ne peut plus être modifiée`
- `[A-413] une fiche extraite est copiée dans la base du client avec son origine, et l'extraction est tracée` (intégration)
- `[A-413] les notes et statuts du client ne remontent jamais dans referentiels`
- `[C-627] une désinscription chez le client A empêche l'extraction de la même personne par B` (intégration)
- `[C-027] la garde de minimisation n'admet que l'exception referentiels`
