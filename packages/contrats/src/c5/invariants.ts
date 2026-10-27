// Invariants du schéma C5 (annexe A), écrits comme contrôles sur le catalogue système de PostgreSQL.
// Aucune table n'est créée ici : le lot 2 branche ces contrôles sur ses vraies migrations.
// Un contrôle renvoie la liste des écarts ; liste vide = schéma conforme.

export type Ecart = { regle: Regle; objet: string };
export const REGLES_C5 = [
  "tenant_id_absent",
  "rls_absente",
  "politique_ouverte",
  "role_contourne_rls",
  "force_rls_absent",
  "index_tenant_absent",
  "proprietaire_application",
  "base_cli_ouverte",
  "base_cli_partagee",
  "journal_modifiable",
  "argent_non_entier",
  "vocabulaire_en_texte",
] as const;
export type Regle = (typeof REGLES_C5)[number];

// `sql` : une requête de lecture ; renvoie les lignes (colonnes nommées). L'appelant fournit la connexion.
export type Requete = (sql: string) => Promise<Record<string, unknown>[]>;

export type Options = {
  // Rôles de connexion de l'application : aucun ne doit posséder une table ni contourner la RLS (invariant 2).
  rolesApplication: RegExp;
  // Seule table exemptée (schéma public) : celle des migrations. Défaut : `__migrations`.
  tableMigrations?: string;
  // Rôles d'administration (propriétaire des bases, migrations) : seuls permis sur plusieurs bases `cli_%`.
  rolesAdministration?: RegExp;
};

export const TABLE_MIGRATIONS = "__migrations";
export const ROLES_ADMINISTRATION = /^(admin|proprietaire)(_|$)/;

// Les 8 invariants de l'annexe A : contrôlés ici dès la version 0, ou à brancher au lot 2 (README.md).
export const INVARIANTS_C5 = [
  { n: 1, texte: "table métier : tenant_id NOT NULL, politique RLS, FORCE ROW LEVEL SECURITY, index qui commence par tenant_id", etat: "controle" },
  { n: 2, texte: "l'application ne se connecte jamais avec le rôle propriétaire, ni avec un rôle qui contourne la RLS", etat: "controle" },
  { n: 3, texte: "base cli_<id> fermée à PUBLIC et un rôle par client : aucun rôle hors administration n'ouvre deux bases cli_", etat: "controle" },
  { n: 4, texte: "journal d'audit en ajout seul (UPDATE, DELETE, TRUNCATE refusés) ; chaînage par hachage", etat: "controle_en_partie" },
  { n: 5, texte: "argent en entiers ; tout vocabulaire en énumération", etat: "controle" },
  { n: 6, texte: "unicités : une ligne de facture d'abonnement par (abonnement, début de période) hors avoirs, sur chaque ligne de chaque facture groupée ou seule ; bon de commande et facture de départ par (client, automatisation) ; Idempotency-Key de la boîte d'envoi ; event_id des faits reçus", etat: "a_brancher_lot_2" },
  { n: 7, texte: "le texte des demandes vit dans cli_<id>, la base console n'en garde que les métadonnées", etat: "a_brancher_lot_2" },
  { n: 8, texte: "migrations additives N / N-1, montante et descendante testées", etat: "a_brancher_lot_2" },
] as const;

// Colonnes dont le contenu est un vocabulaire fermé : énumération obligatoire (invariant 5).
export const VOCABULAIRE = ["statut", "etat", "nature", "canal", "famille", "classe", "niveau", "moyen", "motif", "role", "garantie"] as const;

const MONTANT = /(montant|prix|total|tarif|cout|solde|somme)/;
const JOURNAL = /^journal(_audit)?$/;
const NOM_BASE = /^[a-z0-9_]+$/;

const ENTIERS = new Set(["smallint", "integer", "bigint"]);
const DECIMAUX = new Set(["numeric", "real", "double precision"]);
const TEXTES = new Set(["text", "character varying", "character"]);

const COLONNES = `
  SELECT table_schema AS "schema", table_name AS "table", column_name AS colonne, data_type AS type, is_nullable AS nullable
  FROM information_schema.columns`;
const POLITIQUES = `SELECT schemaname AS "schema", tablename AS "table", permissive, cmd, qual, with_check FROM pg_policies`;
// Index valide, complet (non partiel) dont la 1re colonne de la clé est la colonne tenant_id de la table
// (indkey[0] ; une expression vaut 0, INCLUDE n'est pas dans la clé).
const INDEX = `
  SELECT i.indrelid::int AS oid FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
  WHERE a.attname = 'tenant_id' AND i.indisvalid AND i.indpred IS NULL`;
const DECLENCHEURS = `
  SELECT t.tgrelid::int AS oid, t.tgtype::int AS type, t.tgenabled AS actif
  FROM pg_trigger t WHERE NOT t.tgisinternal`;
// `contourne_par_membre` : le rôle est membre, même indirectement, d'un autre rôle superutilisateur ou BYPASSRLS (SET ROLE suffit).
const ROLES = `
  SELECT r.rolname AS nom, r.rolsuper AS super, r.rolbypassrls AS contourne,
         EXISTS (SELECT 1 FROM pg_roles x WHERE (x.rolsuper OR x.rolbypassrls) AND x.oid <> r.oid AND pg_has_role(r.oid, x.oid, 'MEMBER')) AS contourne_par_membre
  FROM pg_roles r`;

const TGTYPE_DELETE = 8;
const TGTYPE_UPDATE = 16;
const TGTYPE_TRUNCATE = 32;
// Actif en session normale : origine ('O') ou toujours ('A'). 'R' (réplique seulement) et 'D' ne comptent pas.
const ACTIFS = new Set(["O", "A"]);
const CITE_TENANT = /\btenant_id\b/;
const cite = (expression: unknown): boolean => typeof expression === "string" && CITE_TENANT.test(expression);

// Une politique permissive doit retenir les lignes par tenant_id, dans USING (lecture) et dans WITH CHECK (écriture).
// Sans WITH CHECK, PostgreSQL applique USING aux écritures de UPDATE et ALL.
function politiqueOuverte(p: Record<string, unknown>): boolean {
  if (p.permissive !== "PERMISSIVE") return false;
  switch (p.cmd) {
    case "SELECT":
    case "DELETE":
      return !cite(p.qual);
    case "INSERT":
      return !cite(p.with_check);
    default:
      return !cite(p.qual) || (p.with_check != null && !cite(p.with_check));
  }
}

const tablesSql = (migrations: string) => `
  SELECT c.oid::int AS oid, n.nspname AS "schema", c.relname AS nom, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
         pg_get_userbyid(c.relowner) AS proprietaire,
         ARRAY(SELECT r.rolname FROM pg_roles r WHERE pg_has_role(r.oid, c.relowner, 'MEMBER')) AS membres
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
    AND c.relkind IN ('r', 'p') AND NOT (n.nspname = 'public' AND c.relname = '${migrations}')`;

// Les partitions sont contrôlées comme les autres tables : PostgreSQL n'applique pas les politiques du parent
// quand on lit une partition en direct.
export async function controlerInvariants(
  requete: Requete,
  nomBase: string,
  options: Options = { rolesApplication: /^app(_|$)/ },
): Promise<Ecart[]> {
  if (!NOM_BASE.test(nomBase)) throw new Error("nom de base invalide");
  const migrations = options.tableMigrations ?? TABLE_MIGRATIONS;
  if (!NOM_BASE.test(migrations)) throw new Error("nom de table de migrations invalide");
  const [tables, colonnes, politiques, index, declencheurs, roles] = await Promise.all([
    requete(tablesSql(migrations)), requete(COLONNES), requete(POLITIQUES), requete(INDEX), requete(DECLENCHEURS), requete(ROLES),
  ]);
  const ecarts: Ecart[] = [];
  const noter = (regle: Regle, objet: string) => ecarts.push({ regle, objet });
  const cleTable = (schema: unknown, nom: unknown) => `${schema}.${nom}`;
  const nomsTables = new Set(tables.map((t) => cleTable(t.schema, t.nom)));

  for (const r of roles) {
    if (options.rolesApplication.test(String(r.nom)) && (r.super || r.contourne || r.contourne_par_membre)) noter("role_contourne_rls", String(r.nom));
  }

  for (const t of tables) {
    const nom = String(t.nom);
    const objet = t.schema === "public" ? nom : cleTable(t.schema, nom);
    const siennes = politiques.filter((p) => p.schema === t.schema && p.table === nom);
    const tenant = colonnes.find((c) => c.schema === t.schema && c.table === nom && c.colonne === "tenant_id");
    if (!tenant || tenant.nullable !== "NO") noter("tenant_id_absent", objet);
    if (!t.rls || siennes.length === 0) noter("rls_absente", objet);
    if (siennes.some(politiqueOuverte)) noter("politique_ouverte", objet);
    if (!t.force_rls) noter("force_rls_absent", objet);
    if (!index.some((i) => i.oid === t.oid)) noter("index_tenant_absent", objet);
    const membres = Array.isArray(t.membres) ? t.membres : [t.proprietaire];
    if (membres.some((m) => options.rolesApplication.test(String(m)))) noter("proprietaire_application", objet);

    if (JOURNAL.test(nom)) {
      const siens = declencheurs.filter((d) => d.oid === t.oid && ACTIFS.has(String(d.actif)));
      const couvre = (bit: number) => siens.some((d) => (Number(d.type) & bit) !== 0);
      if (!couvre(TGTYPE_UPDATE) || !couvre(TGTYPE_DELETE) || !couvre(TGTYPE_TRUNCATE)) noter("journal_modifiable", objet);
    }
  }

  for (const c of colonnes) {
    if (!nomsTables.has(cleTable(c.schema, c.table))) continue;
    const objet = `${c.schema === "public" ? "" : `${c.schema}.`}${c.table}.${c.colonne}`;
    const nom = String(c.colonne);
    const type = String(c.type);
    if ((nom.endsWith("_centimes") && !ENTIERS.has(type)) || (DECIMAUX.has(type) && MONTANT.test(nom))) noter("argent_non_entier", objet);
    if ((VOCABULAIRE as readonly string[]).includes(nom) && TEXTES.has(type)) noter("vocabulaire_en_texte", objet);
  }

  // Invariant 3, « un rôle par client » : un rôle (hors superutilisateur et administration) qui a CONNECT,
  // directement ou par appartenance, sur plus d'une base cli_ casse l'isolation entre bases de clients. PUBLIC est vu à part.
  const partages = await requete(`
    SELECT r.rolname AS nom, count(DISTINCT d.datname)::int AS bases
    FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a, pg_roles r
    WHERE d.datname LIKE 'cli\\_%' AND a.privilege_type = 'CONNECT' AND a.grantee <> 0
      AND pg_has_role(r.oid, a.grantee, 'MEMBER') AND NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%'
    GROUP BY r.rolname HAVING count(DISTINCT d.datname) > 1`);
  const administration = options.rolesAdministration ?? ROLES_ADMINISTRATION;
  for (const p of partages) if (!administration.test(String(p.nom))) noter("base_cli_partagee", String(p.nom));

  if (nomBase.startsWith("cli_")) {
    const ouverte = await requete(
      `SELECT 1 AS ouverte FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
       WHERE d.datname = '${nomBase}' AND a.grantee = 0 AND a.privilege_type = 'CONNECT'`,
    );
    if (ouverte.length > 0) noter("base_cli_ouverte", nomBase);
  }
  return ecarts;
}
