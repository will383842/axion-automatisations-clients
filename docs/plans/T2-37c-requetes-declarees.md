# Plan · T2-37c : requêtes déclarées en structure (abandon du SQL libre)

Rédigé le 05/11/2026 par le concepteur (sécurité / données). Ce document est un plan : il ne change aucun code du produit.
Exigences visées : A-170, A-229, B-070, B-172, B-173, C-006, C-536 (numéros seuls, voir `spec/req-ids.json`).

## 1. Pourquoi changer d'approche

Le filtre `{{filtre}}` collé dans un texte SQL écrit à la main exige un analyseur qui comprenne le SQL **comme PostgreSQL**.
Cinq tours d'audit ont chacun trouvé un nouveau contournement :

| Tour | Contournement trouvé (résumé) |
|---|---|
| 1 | `OR`, `IS NOT TRUE`, `NOT`, `UNION` / `INTERSECT` / `EXCEPT` défont ou contournent le filtre. |
| 2 | Sous-requête non corrélée ou corrélée sur `etablissement_id` de la requête extérieure ; jointure, virgule, table dérivée dans le `FROM`. |
| 3 | Fonctions qui lisent hors du filtre (`table_to_xml`, `query_to_xml`, `row_to_json`, `to_jsonb`) ; ligne entière par alias nu (`p`, `p::text`, `count(p)`). |
| 4 | Chaînes `E'…'` (guillemet échappé lu comme fin de chaîne), préfixes `U&`, `B`, `X`, `N`, antislash, identifiants entre guillemets doubles (`U&"courriel\005fchiffre"`). |
| 5 | `(expr).fonction` : `('SELECT …').ts_stat` exécute du SQL et lit les autres établissements ; espaces Unicode vus comme séparateurs par PostgreSQL mais pas par le découpeur ; `nom::text(1)` (type avec modificateur). |

Conclusion : tant qu'un texte SQL entre dans le système, la surface d'attaque est la grammaire entière de PostgreSQL 16.
On la supprime : **aucun texte SQL n'est plus fourni par une requête, un module ou un client**. Une requête est un objet JSON
validé par un schéma ; le SQL est **généré** par un seul module de code, avec des identifiants tirés de listes blanches et des valeurs toujours liées (`$n`).

## 2. Structure d'une requête déclarée

Fichier : `apps/api/src/donnees/requetes/structure.ts` (schéma zod, strict partout : toute clé en trop est refusée, jamais ignorée).

```ts
// Tous les noms sont des chaînes ASCII /^[a-z][a-z0-9_]{0,62}$/ ET membres d'une liste blanche tirée du modèle.
type RequeteDeclaree = {
  nom: string;                          // /^[a-z][A-Za-z0-9]{0,63}$/, égal à la clé de la liste
  mode: "lecture";                      // v1 : lecture seulement (voir § 8, écriture)
  metadonnees: boolean;                 // vrai seulement si la sortie n'a QUE des agrégats compter/somme (contrôlé)
  parametres: Record<string, Parametre>;// déclaration des paramètres nommés (voir plus bas)
  forme: Simple | Composee;
};

type Simple = {
  type: "simple";
  table: TableAutorisee;                // ex. "commun.personnes" : clé exacte du modèle, table qui a etablissement_id
  sortie:                               // l'un OU l'autre, jamais les deux
    | { lignes: { colonne: Colonne; alias?: Alias }[] }          // 1 à 30 colonnes non chiffrées
    | { agregats: Agregat[] };                                    // 1 à 10 agrégats, aucune colonne nue
  filtres?: Filtre[];                   // 0 à 10, toujours reliés par AND (aucun OR n'existe dans le schéma)
  tri?: { colonne: Colonne; sens: "asc" | "desc" }[];             // 0 à 3, interdit avec agregats
  limite?: { parametre: string } | { fixe: number };              // 1..200 ; obligatoire si sortie = lignes
};

type Composee = {                       // plusieurs agrégats d'une ligne, sur des tables différentes, en une seule requête
  type: "composee";
  parties: { alias: Alias; table: TableAutorisee; agregat: Agregat; filtres?: Filtre[] }[]; // 2 à 5 parties
};

type Agregat =
  | { fonction: "compter"; alias: Alias }                                  // count(*)::int
  | { fonction: "somme"; colonne: ColonneNumerique; alias: Alias };        // coalesce(sum(c), 0)::float8
  // min / max sur colonne non chiffrée : à ajouter seulement si un appelant en a besoin.

type Filtre = {
  colonne: Colonne;                     // jamais etablissement_id (seul le générateur le pose), jamais une colonne chiffrée
  operateur: "egal" | "different" | "inferieur" | "inferieur_ou_egal" | "superieur" | "superieur_ou_egal"
           | "dans" | "est_nul" | "n_est_pas_nul";
  parametre?: string;                   // obligatoire sauf est_nul / n_est_pas_nul ; aucune valeur littérale n'existe
};

type Parametre =
  | { type: "uuid" } | { type: "texte"; max: number /* ≤ 200 */ } | { type: "entier"; min: number; max: number }
  | { type: "horodatage" } | { type: "liste_uuid"; max: number /* ≤ 100 */ };
  // + defaut?: valeur du même type ; le schéma zod des paramètres d'appel est DÉRIVÉ de cette déclaration.
```

Règles de cohérence (dans un `superRefine`, chacune testée) :

1. `table` ∈ tables du modèle qui ont une colonne `etablissement_id` (aujourd'hui : `commun.personnes`, `commun.listes_prospects`, `commun.index_fichiers`). Une table sans `etablissement_id` n'est pas déclarable (v1).
2. `colonne` ∈ colonnes NON chiffrées de cette table (liste lue dans le modèle, comme aujourd'hui `COLONNES_CHIFFREES` : `bytea`, suffixes `_chiffre` / `_empreinte`, `empreinte`). Une colonne chiffrée est refusée **partout** : sortie, filtre, tri (un filtre sur une empreinte serait un oracle).
3. `etablissement_id` n'est jamais nommé dans une sortie, un filtre ou un tri.
4. `ColonneNumerique` : type du modèle `integer`, `bigint`, `numeric`, `real`, `double precision`.
5. Le type du paramètre est compatible avec le type de la colonne (`uuid` ↔ `uuid`, `texte` ↔ `text`, `entier` ↔ entiers, `horodatage` ↔ `timestamp with time zone`, `liste_uuid` ↔ `dans` sur `uuid`).
6. Tout paramètre déclaré est utilisé, tout paramètre utilisé est déclaré.
7. Alias : `/^[a-z][a-z0-9_]{0,62}$/`, uniques, jamais un nom de colonne chiffrée ni `etablissement_id`. Les colonnes rendues = alias (ou nom de colonne) ; elles remplacent le champ `colonnes` actuel.
8. `metadonnees: true` seulement si la sortie ne contient que des agrégats (`compter`, `somme`) : c'est le schéma qui le prouve, plus une déclaration libre.
9. Clés interdites : la validation passe par `z.strictObject` et des `z.enum` ; `__proto__`, `constructor`, etc. ne sont jamais des membres des listes ; les listes sont des `Set`/`Map`, jamais un objet indexé.

Les listes blanches (tables, colonnes, types de colonnes, présence d'`etablissement_id`) sont **lues dans le modèle** `apps/api/drizzle-cli/*.sql` au chargement, comme le fait déjà `liste.ts` ; sans modèle lisible, le module refuse de se charger. On ajoute la lecture du **type** de chaque colonne.

## 3. Générateur

Fichier : `apps/api/src/donnees/requetes/generer.ts`. Une fonction pure, sans aucune entrée textuelle libre :

```ts
genererSql(r: RequeteDeclaree, valeurs: ValeursValidees, etablissements: string[]): { texte: string; valeurs: unknown[] }
```

Règles :

- **Identifiants** : jamais recopiés depuis l'objet. Le générateur cherche la clé dans la `Map` du modèle et émet la forme **canonique stockée dans le modèle**, toujours entre guillemets doubles : `"commun"."personnes"`, `"t"."cree_le"`. Égalité exacte de chaîne (aucune normalisation Unicode, aucun `toLowerCase`) : un espace Unicode, un homoglyphe ou une majuscule ne sont membres d'aucune liste.
- **Alias de table** : constant (`t`, puis `t1`…`t5` pour une composée), jamais déclaré.
- **Alias de sortie** : contrôlé par l'expression régulière ASCII ancrée, émis entre guillemets doubles.
- **Valeurs** : uniquement `$1…$n`, numérotés par le générateur dans l'ordre d'émission ; chaque `$n` porte un transtypage tiré d'une table fermée selon le type de la colonne (`::uuid`, `::text`, `::int8`, `::timestamptz`, `::uuid[]`). Aucune valeur littérale n'est jamais émise ; la limite fixe est un entier vérifié (1..200) émis en `$n` aussi.
- **Filtre d'établissement** : posé par le générateur comme **premier conjonct** de chaque `WHERE`, `"t"."etablissement_id" = ANY($k::uuid[])`, `$k` = tableau des établissements de la SESSION (jamais d'un paramètre). Les filtres déclarés suivent : `WHERE <établissement> AND (<f1>) AND (<f2>)`.
- **Opérateurs** : table fermée `egal → =`, `different → <>`, `inferieur → <`, `inferieur_ou_egal → <=`, `superieur → >`, `superieur_ou_egal → >=`, `dans → = ANY($n::type[])`, `est_nul → IS NULL`, `n_est_pas_nul → IS NOT NULL` (sur une colonne, dans une parenthèse, après AND : ne peut pas défaire le filtre).
- **Agrégats** : table fermée `compter → count(*)::int`, `somme → coalesce(sum("t"."c"), 0)::float8`.
- **Composée** : `SELECT (SELECT <agrégat> FROM <table1> AS "t1" WHERE "t1"."etablissement_id" = ANY($k::uuid[]) AND …) AS "a1", (SELECT …) AS "a2"` ; chaque sous-requête porte son filtre, qualifié par son propre alias (aucune corrélation possible). Le même `$k` sert à toutes les parties.
- **Tri** : `ORDER BY "t"."c" ASC|DESC` puis toujours `, "t"."id" ASC` si la table a `id` (ordre stable).
- **Limite** : `LIMIT $n` ; sortie `lignes` sans limite = refus au schéma.
- **Invariants vérifiés en sortie** (filet, pas la défense principale) : nombre de `$n` distincts = `valeurs.length` ; le texte ne contient ni `;`, ni `'`, ni `--`, ni `/*`, ni `\`, ni caractère hors ASCII imprimable ; le filtre d'établissement apparaît exactement une fois par table lue. Un invariant faux = exception (erreur de programmation), jamais une requête envoyée.
- **Variantes N / N-1 (A-229)** : `variantes?: { depuis: number; forme: Simple | Composee }[]`, chaque variante validée par le même schéma ; le choix d'après `public.version_structure` reste celui de `service.ts`.

Le validateur lexical et l'analyseur de forme actuels (`jetons`, `validerFormeFiltree`, `MOTS_REFUSES`, `FONCTIONS_SURES`, `TYPES_SURS`…) sont **supprimés** : ils n'ont plus d'entrée à analyser.

## 4. Les trois requêtes de `premieres.ts` dans la structure

| Requête actuelle | Forme déclarée | S'exprime ? |
|---|---|---|
| `compterPersonnes` : `SELECT count(*)::int AS total FROM commun.personnes WHERE {{filtre}}` | `simple`, table `commun.personnes`, `agregats: [{ fonction: "compter", alias: "total" }]`, `metadonnees: true` | Oui, à l'identique. |
| `listerListesProspects` : `SELECT id, nom, cree_le FROM commun.listes_prospects WHERE {{filtre}} ORDER BY cree_le DESC LIMIT $1` | `simple`, table `commun.listes_prospects`, `lignes: [id, nom, cree_le]`, `tri: [{ cree_le, desc }]`, `limite: { parametre: "limite" }`, `parametres.limite: { type: "entier", min: 1, max: 200, defaut: 50 }` | Oui. Différence voulue : le tri ajoute `, "t"."id" ASC` (ordre stable). Le test de non-régression compare les lignes rendues, pas le texte. |
| `etatDonnees` : deux sous-requêtes de projection (personnes, somme de `taille_octets` de `index_fichiers`) | `composee`, parties `personnes` (`compter` sur `commun.personnes`) et `taille_fichiers` (`somme` de `taille_octets` sur `commun.index_fichiers`), `metadonnees: true` | **Pas en forme simple** : il faut la forme `composee` (deux tables dans une même lecture). Avec elle : oui, même texte à l'alias près. |

Ce qui ne s'exprime pas (et n'est pas demandé aujourd'hui) : jointure, `OR`, `GROUP BY`, `HAVING`, `DISTINCT`, fonctions scalaires (`lower`, `date_trunc`…), comparaison entre deux colonnes, valeur littérale, table sans `etablissement_id` (`commun.entreprises`, `commun.exclusions`, `commun.etablissements`, `commun.listes_prospects_personnes`), écriture. Chacun s'ajoutera, s'il le faut, comme **un nouveau cas fermé du schéma et du générateur**, avec son test d'attaque, jamais comme un texte.

Cas particulier, `service.ts` : la lecture des établissements pour l'équipe (`SELECT id FROM commun.etablissements`) est un texte **constant du code**, sans filtre et sans entrée ; il reste une constante du service (hors liste), avec un test qui prouve qu'aucune entrée n'y entre. De même pour la lecture de `public.version_structure`.

## 5. Attaques à tester (toutes doivent être refusées AVANT toute requête envoyée)

Chaque ligne est un test `[B-173]` (ou `[B-172]` pour les colonnes chiffrées), un seul marqueur par test, dans `apps/api/src/donnees/requetes/structure-securite.test.ts`. Deux familles : **(S)** l'objet est refusé par le schéma ; **(G)** on vérifie sur le texte généré que l'attaque est sans effet.

Héritées des tours 1 à 5 (reformulées pour la structure : l'attaquant essaie de les glisser dans un champ) :

1. (S) Champ `sql`, `texte`, `where`, `filtre`, `expression` ou toute clé inconnue, à tout niveau : refusé (objet strict).
2. (S) `OR`, `IS NOT TRUE`, `NOT`, `UNION`, `INTERSECT`, `EXCEPT`, `EXISTS`, `BETWEEN`, `--`, `;` dans un nom de colonne, de table, d'alias ou de paramètre : refusé (regex ASCII + appartenance).
3. (S) Opérateur hors liste (`"or"`, `"="`, `"IS DISTINCT FROM"`, `"~"`, `"like"`) : refusé.
4. (S) Table `commun.personnes p, commun.listes_prospects l`, `commun.personnes JOIN …`, `(SELECT …) x`, table sans `etablissement_id`, table inconnue, `"commun"."personnes"` avec guillemets : refusé.
5. (S) Colonne `etablissement_id` en sortie, en filtre, en tri : refusé.
6. (S) Fonctions `table_to_xml`, `query_to_xml`, `row_to_json`, `to_jsonb`, `ts_stat`, `pg_read_file`, `current_setting` comme colonne, alias, fonction d'agrégat ou opérateur : refusé.
7. (S) Ligne entière : colonne `p`, `t`, `personnes`, `*`, `t.*`, `p::text` : refusé.
8. (S) Préfixes et échappements : `E'…'`, `U&'…'`, `U&"courriel\005fchiffre"`, `B'1'`, `X'ff'`, `N'a'`, antislash, guillemets doubles dans un nom : refusé.
9. (S) Tour 5 : `(expr).fonction` et `('SELECT …').ts_stat` dans un nom de colonne ou d'alias ; `nom::text(1)` ; `nom::personnes` ; tout `:`, `(`, `)`, `.` dans un nom de colonne : refusé.
10. (S) Tour 5 : espaces Unicode (U+00A0, U+2000…U+200B, U+2028, U+3000, U+FEFF) et homoglyphes (cyrillique `е`, `о`) dans tout nom : refusé (égalité exacte, aucune normalisation).
11. (S) Colonnes chiffrées (`courriel_chiffre`, `telephone_empreinte`, `empreinte`, toute colonne `bytea`) en sortie, en alias, en filtre, en tri, en `somme` : refusé ; une colonne `bytea` ajoutée au modèle est refusée sans changer le code.
12. (G) Valeurs hostiles dans un paramètre texte (`' OR true --`, `E'\\'`, `$1`, `{{filtre}}`, `\u0000`, 10 000 caractères) : refusées par la longueur ou envoyées telles quelles en `$n` ; le texte généré est **identique** à celui d'une valeur sage (test d'égalité de texte).
13. (G) Filtre d'établissement : pour toute forme, le texte contient `"t?"."etablissement_id" = ANY($k::uuid[])` exactement une fois par table lue, en premier conjonct, et `$k` reçoit les établissements de la SESSION même si un paramètre s'appelle `etablissements` ou `etablissement_id` (paramètre de ce nom refusé au schéma).
14. (G) Numérotation : pour N paramètres, `$1…$N+1` exactement, chacun utilisé, aucun en double, aucun orphelin (repris de l'actuel test `$n`).
15. (G) Le texte généré ne contient jamais `'`, `;`, `--`, `/*`, `\`, ni caractère hors ASCII imprimable, ni `OR`, `UNION`, ni le nom d'une colonne chiffrée (balayage de toutes les requêtes livrées et d'un jeu de formes générées au hasard, graine fixe).
16. (S) Composée : partie sans table, partie qui n'est pas un agrégat, plus de 5 parties, alias répétés : refusé ; (G) chaque partie porte son propre filtre qualifié par son propre alias (aucune corrélation).
17. (S) `metadonnees: true` avec une sortie `lignes` : refusé ; (G) l'équipe sans vue « comme le client » n'exécute que des requêtes à sortie d'agrégats (B-070, C-006).
18. (S) Pollution de prototype : clés `__proto__`, `constructor`, `prototype` comme nom de requête, de paramètre, de table ou de colonne : refusé ; `Object.hasOwn` sur la liste.
19. (S) Limite : absente sur `lignes`, `0`, `201`, `1.5`, négative, chaîne : refusé ; paramètre `limite` hors bornes à l'appel : `schema_invalide`.
20. (S) Paramètre de type incompatible avec la colonne (`texte` sur `uuid`, `entier` sur `cree_le`) ; `liste_uuid` de plus de 100 éléments à l'appel : refusé.

Essais réels (pour la CI `socle-integration`, fichier `apps/api/src/donnees/requetes/generer.int.test.ts`, pas de résultat inventé localement) : sur une vraie base modèle avec deux établissements, chaque requête livrée ne rend que les lignes de l'établissement de la session ; `EXPLAIN` de chaque texte généré passe ; la valeur hostile du point 12 ne rend aucune ligne d'un autre établissement.

## 6. Migration des appelants

| Appelant | Changement |
|---|---|
| `apps/api/src/donnees/requetes/premieres.ts` | Les trois requêtes réécrites en `RequeteDeclaree` (§ 4). Plus de champ `sql`, `schema`, `valeurs`, `colonnes`. |
| `apps/api/src/donnees/requetes/liste.ts` | Garde la lecture du modèle (colonnes chiffrées, tables) enrichie des types et d'`etablissement_id` ; `verifierListeBlanche` = validation par le schéma + génération à blanc de chaque requête et de ses variantes au chargement. Supprime `jetons`, `validerFormeFiltree`, `premierNiveauFiltre`, `EMPLACEMENT_FILTRE`. L'interface `Requete` devient `RequeteDeclaree`. |
| `apps/api/src/donnees/service.ts` | `executer` : valide les paramètres par le schéma DÉRIVÉ, appelle `genererSql(r ou variante, valeurs, etablissements)`, envoie `{ texte, valeurs }`. Supprime le `replaceAll` du filtre et le contrôle `$n` ad hoc (devenu invariant du générateur). Les colonnes rendues viennent des alias. Le reste (session, vue, pools, refus) ne bouge pas. |
| `apps/api/src/donnees/service.test.ts` | Les deux requêtes de test à texte libre (`ecrireListe`, `deuxVariantes`) deviennent des requêtes déclarées. `ecrireListe` : v1 sans écriture → le test [A-005] « la vue ne peut rien écrire » garde sa portée en vérifiant qu'une déclaration `mode: "ecriture"` est refusée au chargement, et qu'aucun rôle `app` n'est ouvert pour l'équipe. |
| `apps/api/src/donnees/balayage.test.ts` | Même adaptation pour `ecrireListe` (le test porte sur le balayage des pools, il garde une requête qui bloque sur le rôle `app` : prendre une lecture client bloquante si l'écriture n'existe pas). |
| `apps/api/src/donnees/liste-securite.test.ts` | Les tests des tours 1 à 5 sur le texte SQL sont **remplacés** par `structure-securite.test.ts` (§ 5) ; les tests [B-172] sur le modèle (liste des colonnes chiffrées lue dans le SQL du modèle) sont conservés. Aucun test n'est passé en `skip` : chaque attaque ancienne a son équivalent nouveau, listé dans la PR. |
| `packages/contrats/src/c4/donnees.ts` (C4 0.4.0, champ `sql` des requêtes et actions de module) | **Hors de cette fiche.** Le contrat C4 accepte encore un texte SQL de module ; le service ne l'exécute jamais aujourd'hui (l'import T4-50 n'est pas branché). Il faut une révision C4 (champ `requete` structuré au même schéma, `sql` refusé à l'import) : **ADR et accord de l'architecte requis** (CLAUDE.md § 5). Voir § 9. |
| `packages/sdk-module/src/manifeste.ts` | Suit la révision C4, même fiche que ci-dessus. |

## 7. Fichiers touchés (tous dans les « Fichiers autorisés » de T2-37c : `apps/api/src/donnees/**`)

Créés :
- `apps/api/src/donnees/requetes/structure.ts` (schéma, environ 150 lignes)
- `apps/api/src/donnees/requetes/generer.ts` (générateur, environ 120 lignes)
- `apps/api/src/donnees/requetes/modele.ts` (lecture du modèle déplacée depuis `liste.ts`, enrichie des types, environ 60 lignes)
- `apps/api/src/donnees/requetes/structure-securite.test.ts`, `generer.test.ts`, `generer.int.test.ts`

Modifiés : `requetes/liste.ts` (nettement plus court), `requetes/premieres.ts`, `service.ts`, `service.test.ts`, `balayage.test.ts`, `liste-securite.test.ts`.

Ajoutés aussi : un ADR `docs/adr/0109-requetes-declarees-en-structure.md` (prochain numéro libre, à revérifier sur `main` avant d'écrire) et une ligne `spec/preuves.md` (ligne distincte, `merge=union`).
L'ADR est hors des fichiers autorisés de la fiche T2-37c : il faut l'ajouter à la fiche (§ 9) ou le confier au documentaliste.

Non touchés : `.github/workflows/**`, `spec/req-ids.json`, `packages/contrats/**`, `colonnes-chiffrees.ts`, `personnes-chiffrees*`, migrations.
Taille estimée : environ 330 lignes ajoutées hors tests, environ 250 retirées (le validateur) : sous les 400 lignes.

## 8. Ordre des commits (tests rouges d'abord, poussés ensemble à la fin, un seul push)

Sur la branche `lot-2b/T2-37c`, après `git merge origin/main` (jamais de rebase) :

1. **ADR** `0109` : décision « aucun texte SQL fourni ; requêtes déclarées ; générateur unique », options écartées (validateur de texte, analyseur `libpg_query`, vues SQL par requête), conséquences (C4 à réviser).
2. **Tests rouges du schéma** : `structure-securite.test.ts` (§ 5, points 1 à 11, 16 à 20) et la déclaration des trois requêtes de § 4 attendue valide. Rouges : `structure.ts` n'existe pas.
3. **Code du schéma** : `modele.ts` (types de colonnes, `etablissement_id`), `structure.ts`. Les tests du commit 2 passent au vert.
4. **Tests rouges du générateur** : `generer.test.ts` (texte attendu exact des trois requêtes, points 12 à 15, variantes) et `generer.int.test.ts` (pour la CI socle).
5. **Code du générateur** : `generer.ts`. Vert.
6. **Tests rouges du service** : `service.test.ts` et `balayage.test.ts` réécrits sur les requêtes déclarées (même portée : session, vue, pools, `$n`, mauvais client) ; l'ancien `liste-securite.test.ts` réduit à ses tests [B-172] sur le modèle. Rouges : le service attend encore `sql`.
7. **Migration** : `premieres.ts`, `liste.ts`, `service.ts` ; suppression du validateur de texte. Vert.
8. **Preuves** : ligne `spec/preuves.md`, `spec/compte-tests*.json`.
9. `pnpm verifier` vert, puis **un seul push** ; corps de PR mis à jour (attaques des tours 1 à 5 → test qui les couvre).

## 9. Critères à ajouter à la fiche T2-37c (par le chef d'orchestre, dans le dépôt privé)

- (o) Aucun texte SQL n'est fourni par une requête de la liste : le type `Requete` n'a plus de champ `sql` ; un test [B-173] prouve qu'une déclaration avec `sql` (ou toute clé inconnue) est refusée au chargement.
- (p) Le SQL du service des données n'est produit que par `genererSql` (ou par les deux constantes du service : établissements, version de structure) ; un test [A-170] balaie `apps/api/src/donnees/**` et refuse tout autre texte `SELECT` envoyé à `Connexion.requete`.
- (q) Le filtre d'établissement est posé par le générateur, en premier conjonct de chaque `WHERE`, une fois par table lue ; testé sur toutes les formes, simple et composée [B-173].
- (r) Chaque contournement des tours 1 à 5 a un test nommé dans `structure-securite.test.ts`, listé dans le corps de la PR.
- (s) Les trois requêtes de `premieres.ts` rendent les mêmes lignes qu'avant (essai `generer.int.test.ts` vert dans `socle-integration`).
- (t) Fichiers autorisés en plus : `docs/adr/0109-requetes-declarees-en-structure.md`.
- (u) Dette, propriétaire à nommer (fiche C4 / T4-50, avec l'architecte) : révision C4 qui remplace `sql` par la structure déclarée pour les requêtes et actions de module, et refus de `sql` à l'import.
- (v) Dette, propriétaire à nommer : écriture déclarée (insertion et mise à jour structurées, filtre d'établissement posé par le générateur, historique par le port) ; tant qu'elle n'existe pas, `mode: "ecriture"` est refusé au chargement.

## 10. Risques

| Risque | Parade |
|---|---|
| Un besoin futur (jointure, `OR`, `GROUP BY`) pousse à rouvrir un champ texte. | ADR : toute extension est un cas fermé du schéma avec son test d'attaque ; un champ texte SQL est un refus de principe, relu par l'auditeur sécurité. |
| Bogue du générateur (filtre oublié dans une nouvelle forme). | Invariants vérifiés en sortie (§ 3) + balayage du point 15 + essai réel par établissement. |
| Le modèle change (colonne renommée, nouvelle colonne `bytea`). | Listes lues dans le modèle au chargement ; chargement refusé si une requête livrée cite une colonne absente ; colonne `bytea` nouvelle refusée d'office. |
| Table sans `etablissement_id` (ex. `commun.entreprises`) un jour nécessaire. | Non déclarable en v1 ; l'ouvrir demande une règle d'isolation propre (jointure fermée générée), donc un ADR. |
| C4 0.4.0 accepte encore du SQL de module. | Rien ne l'exécute aujourd'hui ; dette (u) avec propriétaire avant que T4-50 branche l'import. **ESCALADE** : la révision C4 demande l'accord de l'architecte. |
| `like` / `ilike` réclamés plus tard (motif coûteux). | Absents en v1 ; si ajoutés : paramètre borné en longueur, `starts_with()` plutôt qu'un motif libre. |
| Écart de texte (ordre stable ajouté) casse un test fragile. | Tests de non-régression sur les lignes rendues, pas sur le texte, sauf dans `generer.test.ts`. |
| Taille de PR proche de 400 lignes. | Le validateur supprimé compense ; sinon découper : PR 1 schéma + générateur, PR 2 migration du service (même fiche, accord du chef d'orchestre). |
| État des dépôts liés (`axion-ia`, Axion-CRM-Pro) changé depuis la fiche. | À revérifier sur `main` par l'exécutant avant de coder (CLAUDE.md § 3) ; ce plan ne dépend d'aucun d'eux. |
