import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule, parseSync } from "libpg-query";

// Garde des migrations (A-233) : aucune migration ne supprime, ne renomme ni ne change le type de ce qui existe.
// Le SQL est lu par l'analyseur de PostgreSQL lui-même (libpg-query) : on parcourt l'arbre, jamais de découpage maison ni d'expression régulière.
// Les corps de fonction, de procédure et de DO sont opaques pour l'analyseur : ces instructions sont refusées.
// Seule exception (ADR 0041) : une fonction de la liste fermée scripts/garde-migrations-fonctions.json, identifiée par le fichier, son nom et l'empreinte SHA-256 de son texte.
await loadModule();

export type FonctionPermise = { fichier: string; nom: string; empreinte: string; adr: string };

function chargerFonctions(): FonctionPermise[] {
  const brut: unknown = JSON.parse(readFileSync(new URL("./garde-migrations-fonctions.json", import.meta.url), "utf8"));
  const liste = (brut as { fonctions?: unknown } | null)?.fonctions;
  if (!Array.isArray(liste)) throw new Error("garde-migrations-fonctions.json : tableau « fonctions » attendu");
  return liste.map((f: Record<string, unknown>) => {
    const ok =
      typeof f?.["fichier"] === "string" && /^\d{4}_[a-z0-9_]+\.sql$/.test(f["fichier"]) &&
      typeof f["nom"] === "string" && /^[a-z_][a-z0-9_]*$/.test(f["nom"]) &&
      typeof f["empreinte"] === "string" && /^[0-9a-f]{64}$/.test(f["empreinte"]) &&
      typeof f["adr"] === "string" && /^\d{4}$/.test(f["adr"]);
    if (!ok) throw new Error(`garde-migrations-fonctions.json : entrée invalide : ${JSON.stringify(f)?.slice(0, 80)}`);
    return f as unknown as FonctionPermise;
  });
}
// Liste réelle, lue une fois : elle fait partie du dépôt, jamais d'une option d'appel du programme.
export const FONCTIONS_PERMISES: readonly FonctionPermise[] = Object.freeze(chargerFonctions());

// Nœud de l'arbre → étiquette du refus.
const NOEUDS = new Map([
  ["DropStmt", "DROP"], ["DropOwnedStmt", "DROP"], ["DropRoleStmt", "DROP"], ["DropdbStmt", "DROP"], ["DropTableSpaceStmt", "DROP"], ["DropSubscriptionStmt", "DROP"], ["DropUserMappingStmt", "DROP"],
  ["RenameStmt", "RENAME"], ["TruncateStmt", "TRUNCATE"], ["AlterObjectSchemaStmt", "SET SCHEMA"],
  ["VariableSetStmt", "SET"], ["AlterDatabaseSetStmt", "ALTER DATABASE SET"], ["AlterRoleSetStmt", "ALTER ROLE SET"],
  ["DoStmt", "DO"], ["CreateFunctionStmt", "CREATE FUNCTION"], ["CallStmt", "CALL"], ["ExecuteStmt", "EXECUTE"], ["TransactionStmt", "COMMIT/ROLLBACK"],
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
    // pg_settings porte une règle ON UPDATE qui appelle set_config : toute relation de ce nom (RangeVar), quel que soit le schéma, est refusée.
    if (cle === "relname" && typeof valeur === "string" && valeur.toLowerCase() === "pg_settings") trouvees.push("pg_settings");
    if (cle === "FuncCall") {
      const nom = (valeur as { funcname?: { String?: { sval?: string } }[] }).funcname?.at(-1)?.String?.sval;
      if (nom?.toLowerCase() === "set_config") trouvees.push("set_config");
    }
    etiquettes(valeur, trouvees);
  }
}

// Texte d'une instruction, tel que haché : positions en OCTETS (libpg-query), fins de ligne normalisées, espaces des bords retirés.
// stmt_len = 0 veut dire « jusqu'à la fin du morceau ».
function texteInstruction(texte: string, s: { stmt_location?: number; stmt_len?: number }): string {
  const octets = Buffer.from(texte, "utf8");
  const debut = s.stmt_location ?? 0;
  return octets.subarray(debut, s.stmt_len ? debut + s.stmt_len : undefined).toString("utf8").replace(/\r\n/g, "\n").trim();
}
const empreinteDe = (texte: string) => createHash("sha256").update(texte, "utf8").digest("hex");

type Option = { DefElem?: { defname?: string; arg?: { VariableSetStmt?: { kind?: string; name?: string }; Boolean?: { boolval?: boolean } } } };
type Fonction = { nom: string; options: Option[]; estProcedure: boolean; corps: object };
function racineFonction(stmt: unknown): Fonction | undefined {
  const f = (stmt as { CreateFunctionStmt?: { funcname?: { String?: { sval?: string } }[]; options?: Option[]; is_procedure?: boolean } } | undefined)?.CreateFunctionStmt;
  return f ? { nom: f.funcname?.at(-1)?.String?.sval ?? "", options: f.options ?? [], estProcedure: f.is_procedure === true, corps: f } : undefined;
}

// Drizzle découpe le fichier sur ce marqueur et envoie chaque morceau séparément : la garde analyse les mêmes morceaux.
const MARQUEUR = "--> statement-breakpoint";

function analyserMorceau(nom: string, texte: string, fonctions: readonly FonctionPermise[], utilisees?: Set<FonctionPermise>): string[] {
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
    let trouvees: string[] = [];
    etiquettes(s.stmt, trouvees);
    const fonction = racineFonction(s.stmt);
    if (fonction && !fonction.estProcedure) {
      const empreinte = empreinteDe(texteInstruction(texte, s));
      const permise = fonctions.find((f) => f.fichier === basename(nom) && f.nom === fonction.nom && f.empreinte === empreinte);
      if (permise) {
        utilisees?.add(permise);
        // La fonction relue lève CREATE FUNCTION et ses propres options SET ; toute autre étiquette de l'instruction reste.
        trouvees = [];
        etiquettes({ ...fonction.corps, options: fonction.options.filter((o) => o.DefElem?.defname !== "set") }, trouvees);
        const definer = fonction.options.some((o) => o.DefElem?.defname === "security" && o.DefElem.arg?.Boolean?.boolval === true);
        const cheminFixe = fonction.options.some((o) => o.DefElem?.defname === "set" && o.DefElem.arg?.VariableSetStmt?.kind === "VAR_SET_VALUE" && o.DefElem.arg.VariableSetStmt.name === "search_path");
        if (definer && !cheminFixe) trouvees.push("SECURITY DEFINER sans search_path");
      }
    }
    return trouvees.map((t) => `${nom}:${ligne}: instruction interdite : ${t}`);
  });
}

export function analyserSql(nom: string, texte: string, fonctions: readonly FonctionPermise[] = FONCTIONS_PERMISES, utilisees?: Set<FonctionPermise>): string[] {
  return texte.split(MARQUEUR).flatMap((morceau) => (morceau.trim() ? analyserMorceau(nom, morceau, fonctions, utilisees) : []));
}

// Aide à l'écriture de la liste fermée : nom et empreinte de chaque fonction d'un fichier (node scripts/garde-migrations.ts --empreintes <fichier.sql>).
export function empreintesFonctions(texte: string): { nom: string; empreinte: string }[] {
  return texte.split(MARQUEUR).flatMap((morceau) =>
    morceau.trim()
      ? parseSync(morceau).stmts.flatMap((s: { stmt?: unknown; stmt_location?: number; stmt_len?: number }) => {
          const f = racineFonction(s.stmt);
          return f && !f.estProcedure ? [{ nom: f.nom, empreinte: empreinteDe(texteInstruction(morceau, s)) }] : [];
        })
      : [],
  );
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

export function verifierDossier(dossier: string, base = dossier, fonctions: readonly FonctionPermise[] = FONCTIONS_PERMISES, utilisees?: Set<FonctionPermise>): string[] {
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
      // Drizzle compare les migrations par date : une date plus ancienne que la dernière appliquée est sautée sans erreur.
      const dates = entrees.map((e) => (e as { when?: unknown }).when);
      if (dates.some((d, i) => typeof d !== "number" || !Number.isFinite(d) || (i > 0 && d <= (dates[i - 1] as number)))) {
        return [`${nom(join(dossier, "meta/_journal.json"))} : dates when non strictement croissantes (migration générée sur une branche périmée : repartir de main et régénérer)`];
      }
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") return [`${nom(join(dossier, "meta/_journal.json"))} : journal illisible`];
      return presents.length ? [`${nom(dossier)} : journal absent (meta/_journal.json) alors que des fichiers SQL existent`] : [];
    }
    const listes = new Set(tags.map((t) => join(dossier, `${t}.sql`)));
    const erreurs = presents.filter((f) => !listes.has(f)).map((f) => `${nom(f)} : fichier SQL absent du journal`);
    for (const f of listes) {
      if (!presents.includes(f)) erreurs.push(`${nom(f)} : fichier du journal introuvable`);
      else erreurs.push(...analyserSql(nom(f), readFileSync(f, "utf8"), fonctions, utilisees));
    }
    return erreurs;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [];
    return [(e as Error).message];
  }
}

export function gardeMigrations(racine: string, fonctions: readonly FonctionPermise[] = FONCTIONS_PERMISES): string[] {
  const apps = join(racine, "apps");
  const utilisees = new Set<FonctionPermise>();
  const erreurs = readdirSync(apps, { withFileTypes: true })
    .filter((a) => a.isDirectory())
    .flatMap((a) => verifierDossier(join(apps, a.name, "drizzle"), racine, fonctions, utilisees));
  // Une entrée qui ne correspond à aucune instruction est une exception morte : elle ne doit pas rester dans la liste.
  const mortes = fonctions.filter((f) => !utilisees.has(f)).map((f) => `scripts/garde-migrations-fonctions.json : entrée sans instruction correspondante : ${f.fichier} ${f.nom}`);
  return [...erreurs, ...mortes];
}

// Usage : node scripts/garde-migrations.ts [racine]
//         node scripts/garde-migrations.ts --empreintes <fichier.sql>
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--empreintes") {
  const fichier = process.argv[3];
  if (!fichier) {
    console.error("usage : node scripts/garde-migrations.ts --empreintes <fichier.sql>");
    process.exit(2);
  }
  for (const f of empreintesFonctions(readFileSync(fichier, "utf8"))) console.log(`${f.nom} ${f.empreinte}`);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const erreurs = gardeMigrations(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
