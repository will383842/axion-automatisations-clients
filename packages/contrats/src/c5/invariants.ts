// Invariants du schéma C5 (annexe A), écrits comme contrôles sur le catalogue système de PostgreSQL.
// Aucune table n'est créée ici : le lot 2 branche ces contrôles sur ses vraies migrations.
// Un contrôle renvoie la liste des écarts ; liste vide = schéma conforme.

export type Ecart = { regle: Regle; objet: string };
export type Regle =
  | "tenant_id_absent"
  | "rls_absente"
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
  // Rôles de connexion de l'application : aucun ne doit posséder une table (invariant 2).
  rolesApplication: RegExp;
};

// Colonnes dont le contenu est un vocabulaire fermé : énumération obligatoire (invariant 5).
export const VOCABULAIRE = ["statut", "etat", "nature", "canal", "famille", "classe", "niveau", "moyen", "motif", "role", "garantie"] as const;

const MONTANT = /(montant|prix|total|tarif|cout|solde|somme)/;
const JOURNAL = /^journal(_audit)?$/;
const NOM_BASE = /^[a-z0-9_]+$/;

const ENTIERS = new Set(["smallint", "integer", "bigint"]);
const DECIMAUX = new Set(["numeric", "real", "double precision"]);
const TEXTES = new Set(["text", "character varying", "character"]);

const TABLES = `
  SELECT c.oid::int AS oid, c.relname AS nom, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
         pg_get_userbyid(c.relowner) AS proprietaire,
         (SELECT count(*) FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname)::int AS politiques
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname NOT LIKE '\\_\\_%'`;
const COLONNES = `
  SELECT table_name AS "table", column_name AS colonne, data_type AS type, is_nullable AS nullable
  FROM information_schema.columns WHERE table_schema = 'public'`;
const INDEX = `SELECT tablename AS "table", indexdef AS definition FROM pg_indexes WHERE schemaname = 'public'`;
const DECLENCHEURS = `
  SELECT c.relname AS "table", t.tgtype::int AS type, t.tgenabled AS actif
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal`;

const TGTYPE_DELETE = 8;
const TGTYPE_UPDATE = 16;
const PAR_TENANT = /\(\s*"?tenant_id"?\s*[,)\s]/;

export async function controlerInvariants(
  requete: Requete,
  nomBase: string,
  options: Options = { rolesApplication: /^app(_|$)/ },
): Promise<Ecart[]> {
  if (!NOM_BASE.test(nomBase)) throw new Error("nom de base invalide");
  const [tables, colonnes, index, declencheurs] = await Promise.all([requete(TABLES), requete(COLONNES), requete(INDEX), requete(DECLENCHEURS)]);
  const ecarts: Ecart[] = [];
  const noter = (regle: Regle, objet: string) => ecarts.push({ regle, objet });
  const nomsTables = new Set(tables.map((t) => String(t.nom)));

  for (const t of tables) {
    const nom = String(t.nom);
    const tenant = colonnes.find((c) => c.table === nom && c.colonne === "tenant_id");
    if (!tenant || tenant.nullable !== "NO") noter("tenant_id_absent", nom);
    if (!t.rls || Number(t.politiques) === 0) noter("rls_absente", nom);
    if (!t.force_rls) noter("force_rls_absent", nom);
    if (!index.some((i) => i.table === nom && PAR_TENANT.test(String(i.definition)))) noter("index_tenant_absent", nom);
    if (options.rolesApplication.test(String(t.proprietaire))) noter("proprietaire_application", nom);

    if (JOURNAL.test(nom)) {
      const sien = declencheurs.filter((d) => d.table === nom && d.actif !== "D");
      const couvre = (bit: number) => sien.some((d) => (Number(d.type) & bit) !== 0);
      if (!couvre(TGTYPE_UPDATE) || !couvre(TGTYPE_DELETE)) noter("journal_modifiable", nom);
    }
  }

  for (const c of colonnes) {
    if (!nomsTables.has(String(c.table))) continue;
    const objet = `${c.table}.${c.colonne}`;
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
