import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Garde des licences : liste fermée, MPL-2.0 seulement pour apps/api et apps/executeur.

const PERMISES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "OFL-1.1"]);
const MPL = "MPL-2.0";

// Exceptions NOMMÉES (paquet + licence), réservées aux dépendances de développement (ADR 0007).
const EXCEPTIONS_DEV: Record<string, string> = { argparse: "Python-2.0", minimatch: "BlueOak-1.0.0" };

type Paquets = Record<string, { name: string }[]>;

export function verifierLicences(parLicence: Paquets, nomsMpl: Set<string>, nomsProduction: Set<string> = new Set()): string[] {
  const erreurs: string[] = [];
  for (const [licence, paquets] of Object.entries(parLicence)) {
    const ok = (id: string, nom: string) =>
      PERMISES.has(id) || (id === MPL && nomsMpl.has(nom)) || (EXCEPTIONS_DEV[nom] === id && !nomsProduction.has(nom));
    for (const p of paquets) {
      const permis = licence
        .replace(/[()]/g, "")
        .split(/\s+OR\s+/)
        .some((branche) => branche.split(/\s+AND\s+/).every((id) => ok(id.trim(), p.name)));
      if (!permis) erreurs.push(`${p.name} : licence « ${licence} » non permise`);
    }
  }
  return erreurs;
}

// pnpm écrit un message en texte brut (et non du JSON) quand aucun paquet ne correspond.
const lister = (filtres: string[] = [], options: string[] = []): Paquets => {
  const sortie = execFileSync("pnpm", [...filtres, "licenses", "list", "--json", ...options], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return sortie.trimStart().startsWith("{") ? (JSON.parse(sortie) as Paquets) : {};
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const serveur = lister(["--filter", "@axion-auto/api", "--filter", "@axion-auto/executeur"]);
  const nomsMpl = new Set((serveur[MPL] ?? []).map((p) => p.name));
  const nomsProduction = new Set(Object.values(lister([], ["--prod"])).flatMap((ps) => ps.map((p) => p.name)));
  const erreurs = verifierLicences(lister(), nomsMpl, nomsProduction);
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
