import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Index des ADR généré à partir des fichiers (plus de liste à la main : une PR n'édite plus un fichier commun).
// `docs/adr/index.md` est un fichier local (ignoré par git) ; la garde refuse les numéros en double et un index écrit périmé.

export type Adr = { fichier: string; numero: string; titre: string };

const TITRE = /^#\s*(?:ADR\s+)?(\d{4})\s*[—·–-]\s*(.+?)\s*$/;
const NOM = /^(\d{4})-.+\.md$/;

export function lireAdr(_fichier: string, premiereLigne: string): { numero: string; titre: string } | null {
  const m = TITRE.exec(premiereLigne);
  return m ? { numero: m[1] ?? "", titre: m[2] ?? "" } : null;
}

export function genererIndex(adrs: Adr[]): string {
  const lignes = [...adrs].sort((a, b) => a.numero.localeCompare(b.numero)).map((a) => `| ${a.numero} | ${a.titre} |`);
  return ["<!-- Généré par scripts/adr-index.ts : ne pas éditer. -->", "| N° | Titre |", "|---|---|", ...lignes, ""].join("\n");
}

export function verifierAdr(adrs: Adr[]): string[] {
  const erreurs: string[] = [];
  const parNumero = new Map<string, string[]>();
  for (const a of adrs) {
    const nom = NOM.exec(a.fichier)?.[1];
    if (nom !== a.numero) erreurs.push(`${a.fichier} : le numéro du nom (${nom ?? "absent"}) n'est pas celui du titre (${a.numero})`);
    parNumero.set(a.numero, [...(parNumero.get(a.numero) ?? []), a.fichier]);
  }
  for (const [numero, fichiers] of parNumero) {
    if (fichiers.length > 1) erreurs.push(`numéro ${numero} pris deux fois : ${fichiers.sort().join(", ")}`);
  }
  return erreurs;
}

export function lireDepot(racine: string): { adrs: Adr[]; erreurs: string[] } {
  const dossier = join(racine, "docs/adr");
  const adrs: Adr[] = [];
  const erreurs: string[] = [];
  const tous = existsSync(dossier) ? readdirSync(dossier).sort() : [];
  for (const f of tous) {
    if (!NOM.test(f) && f !== "README.md" && f !== "index.md") erreurs.push(`${f} : nom non conforme (attendu « 0000-sujet.md »), ni indexé ni contrôlé`);
  }
  const fichiers = tous.filter((f) => NOM.test(f));
  for (const fichier of fichiers) {
    const lu = lireAdr(fichier, readFileSync(join(dossier, fichier), "utf8").split("\n")[0] ?? "");
    if (lu) adrs.push({ fichier, ...lu });
    else erreurs.push(`${fichier} : première ligne illisible (attendu « # 0000 · Titre »)`);
  }
  return { adrs, erreurs };
}

export function verifierDepot(racine: string): string[] {
  const { adrs, erreurs } = lireDepot(racine);
  const index = join(racine, "docs/adr/index.md");
  const perime = existsSync(index) && readFileSync(index, "utf8") !== genererIndex(adrs);
  return [...erreurs, ...verifierAdr(adrs), ...(perime ? ["docs/adr/index.md est périmé : relancer `node scripts/adr-index.ts --ecrire`"] : [])];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const racine = fileURLToPath(new URL("..", import.meta.url));
  const [mode] = process.argv.slice(2);
  const { adrs } = lireDepot(racine);
  if (mode === "--verifier") {
    const erreurs = verifierDepot(racine);
    for (const e of erreurs) console.error(e);
    process.exit(erreurs.length ? 1 : 0);
  } else if (mode === "--ecrire") {
    writeFileSync(join(racine, "docs/adr/index.md"), genererIndex(adrs));
  } else {
    process.stdout.write(genererIndex(adrs));
  }
}
