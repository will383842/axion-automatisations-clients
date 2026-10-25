import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule, parseSync } from "libpg-query";

// Garde des migrations (A-233) : aucune migration ne supprime, ne renomme ni ne change le type de ce qui existe.
// Le SQL est lu par l'analyseur de PostgreSQL lui-même (libpg-query) : on parcourt l'arbre, jamais de découpage maison ni d'expression régulière.
// Les corps de fonction, de procédure et de DO sont opaques pour l'analyseur : ces instructions sont refusées (exception par ADR).
await loadModule();

// Nœud de l'arbre → étiquette du refus.
const NOEUDS = new Map([
  ["DropStmt", "DROP"], ["DropOwnedStmt", "DROP"], ["DropRoleStmt", "DROP"], ["DropdbStmt", "DROP"], ["DropTableSpaceStmt", "DROP"], ["DropSubscriptionStmt", "DROP"], ["DropUserMappingStmt", "DROP"],
  ["RenameStmt", "RENAME"], ["TruncateStmt", "TRUNCATE"], ["AlterObjectSchemaStmt", "SET SCHEMA"],
  ["VariableSetStmt", "SET"], ["AlterDatabaseSetStmt", "ALTER DATABASE SET"], ["AlterRoleSetStmt", "ALTER ROLE SET"],
  ["DoStmt", "DO"], ["CreateFunctionStmt", "CREATE FUNCTION"], ["CallStmt", "CALL"], ["ExecuteStmt", "EXECUTE"],
]);

function etiquettes(noeud: unknown, trouvees: string[]): void {
  if (Array.isArray(noeud)) return noeud.forEach((n) => etiquettes(n, trouvees));
  if (typeof noeud !== "object" || noeud === null) return;
  for (const [cle, valeur] of Object.entries(noeud)) {
    const etiquette = NOEUDS.get(cle);
    if (etiquette) trouvees.push(etiquette);
    if (cle === "AlterTableCmd") {
      const sousType = (valeur as { subtype?: string }).subtype ?? "";
      if (sousType === "AT_AlterColumnType") trouvees.push("ALTER … TYPE");
      else if (sousType.startsWith("AT_Drop")) trouvees.push("DROP");
    }
    if (cle === "AlterEnumStmt" && (valeur as { oldVal?: string }).oldVal) trouvees.push("RENAME");
    if (cle === "AlterDomainStmt" && (valeur as { subtype?: string }).subtype === "X") trouvees.push("DROP");
    if (cle === "FuncCall") {
      const nom = (valeur as { funcname?: { String?: { sval?: string } }[] }).funcname?.at(-1)?.String?.sval;
      if (nom?.toLowerCase() === "set_config") trouvees.push("set_config");
    }
    etiquettes(valeur, trouvees);
  }
}

// Drizzle découpe le fichier sur ce marqueur et envoie chaque morceau séparément : la garde analyse les mêmes morceaux.
const MARQUEUR = "--> statement-breakpoint";

function analyserMorceau(nom: string, texte: string): string[] {
  let stmts: { stmt?: unknown; stmt_location?: number }[];
  try {
    stmts = parseSync(texte).stmts;
  } catch (e) {
    return [`${nom}: SQL illisible : ${e instanceof Error ? e.message : "erreur inconnue"}`];
  }
  return stmts.flatMap((s) => {
    let debut = s.stmt_location ?? 0;
    while (/\s/.test(texte[debut] ?? "x")) debut++;
    const ligne = texte.slice(0, debut).split("\n").length;
    const trouvees: string[] = [];
    etiquettes(s.stmt, trouvees);
    return trouvees.map((t) => `${nom}:${ligne}: instruction interdite : ${t}`);
  });
}

export function analyserSql(nom: string, texte: string): string[] {
  return texte.split(MARQUEUR).flatMap((morceau) => (morceau.trim() ? analyserMorceau(nom, morceau) : []));
}

// Drizzle applique exactement les fichiers `<tag>.sql` du journal : on analyse ces fichiers-là, et seulement des tags simples.
const TAG = /^\d{4}_[a-z0-9_]+$/;

function fichiersSql(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const chemin = join(dossier, e.name);
    if (lstatSync(chemin).isSymbolicLink()) throw new Error(`${chemin} : lien symbolique interdit dans un dossier de migrations`);
    if (e.isDirectory()) return fichiersSql(chemin);
    return e.name.toLowerCase().endsWith(".sql") ? [chemin] : [];
  });
}

export function verifierDossier(dossier: string, base = dossier): string[] {
  const nom = (chemin: string) => relative(base, chemin) || ".";
  try {
    const presents = fichiersSql(dossier);
    let tags: string[] = [];
    try {
      const journal: unknown = JSON.parse(readFileSync(join(dossier, "meta/_journal.json"), "utf8"));
      const entrees = (journal as { entries?: { tag?: unknown }[] }).entries;
      if (!Array.isArray(entrees)) return [`${nom(join(dossier, "meta/_journal.json"))} : journal illisible`];
      const mauvais = entrees.map((e) => e?.tag).filter((t) => typeof t !== "string" || !TAG.test(t));
      if (mauvais.length) return mauvais.map((t) => `${nom(join(dossier, "meta/_journal.json"))} : tag de journal invalide : ${JSON.stringify(t)?.slice(0, 60)}`);
      tags = entrees.map((e) => e.tag as string);
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") return [`${nom(join(dossier, "meta/_journal.json"))} : journal illisible`];
      return presents.length ? [`${nom(dossier)} : journal absent (meta/_journal.json) alors que des fichiers SQL existent`] : [];
    }
    const listes = new Set(tags.map((t) => join(dossier, `${t}.sql`)));
    const erreurs = presents.filter((f) => !listes.has(f)).map((f) => `${nom(f)} : fichier SQL absent du journal`);
    for (const f of listes) {
      if (!presents.includes(f)) erreurs.push(`${nom(f)} : fichier du journal introuvable`);
      else erreurs.push(...analyserSql(nom(f), readFileSync(f, "utf8")));
    }
    return erreurs;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [];
    return [(e as Error).message];
  }
}

export function gardeMigrations(racine: string): string[] {
  const apps = join(racine, "apps");
  return readdirSync(apps, { withFileTypes: true })
    .filter((a) => a.isDirectory())
    .flatMap((a) => verifierDossier(join(apps, a.name, "drizzle"), racine));
}

// Usage : node scripts/garde-migrations.ts [racine]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const erreurs = gardeMigrations(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
