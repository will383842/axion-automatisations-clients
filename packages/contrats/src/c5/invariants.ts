// Invariants du schéma C5 (annexe A), écrits comme contrôles sur le catalogue système de PostgreSQL.
// Aucune table n'est créée ici : le lot 2 branche ces contrôles sur ses vraies migrations.
// Un contrôle renvoie la liste des écarts ; liste vide = schéma conforme.

export type Ecart = { regle: Regle; objet: string };
export type Regle =
  | "tenant_id_absent"
  | "rls_absente"
  | "politique_ouverte"
  | "role_contourne_rls"
  | "force_rls_absent"
  | "index_tenant_absent"
  | "proprietaire_application"
  | "base_cli_ouverte"
  | "journal_modifiable"
  | "argent_non_entier"
  | "vocabulaire_en_texte";

// `sql` : une requête de lecture ; renvoie les lignes (colonnes nommées). L'appelant fournit la connexion.
export type Requete = (sql: string) => Promise<Record<string, unknown>[]>;

export type Options = {
  // Rôles de connexion de l'application : aucun ne doit posséder une table ni contourner la RLS (invariant 2).
  rolesApplication: RegExp;
  // Seule table exemptée (schéma public) : celle des migrations. Défaut : `__migrations`.
  tableMigrations?: string;
};

export const TABLE_MIGRATIONS = "__migrations";

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
const ROLES = `SELECT rolname AS nom, rolsuper AS super, rolbypassrls AS contourne FROM pg_roles`;

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
         pg_get_userbyid(c.relowner) AS proprietaire
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
    if (options.rolesApplication.test(String(r.nom)) && (r.super || r.contourne)) noter("role_contourne_rls", String(r.nom));
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
    if (options.rolesApplication.test(String(t.proprietaire))) noter("proprietaire_application", objet);

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

  if (nomBase.startsWith("cli_")) {
    const ouverte = await requete(
      `SELECT 1 AS ouverte FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
       WHERE d.datname = '${nomBase}' AND a.grantee = 0 AND a.privilege_type = 'CONNECT'`,
    );
    if (ouverte.length > 0) noter("base_cli_ouverte", nomBase);
  }
  return ecarts;
}
