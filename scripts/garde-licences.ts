import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Garde des licences : liste fermée, MPL-2.0 seulement pour apps/api et apps/executeur.

const PERMISES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "OFL-1.1"]);
const MPL = "MPL-2.0";

// Exceptions NOMMÉES (paquet + licence), réservées aux dépendances de développement (ADR 0007, ADR 0008).
const EXCEPTIONS_DEV: Record<string, string> = { argparse: "Python-2.0", minimatch: "BlueOak-1.0.0", nodemailer: "MIT-0" };

type Paquets = Record<string, { name: string }[]>;

// Expression SPDX : AND lie plus fort que OR, parenthèses récursives. Toute expression illisible est refusée.
function expressionPermise(expression: string, ok: (id: string) => boolean): boolean {
  const jetons = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const ou = (): boolean => {
    let v = et();
    while (jetons[i] === "OR") {
      i++;
      const w = et();
      v = v || w;
    }
    return v;
  };
  const et = (): boolean => {
    let v = atome();
    while (jetons[i] === "AND") {
      i++;
      const w = atome();
      v = v && w;
    }
    return v;
  };
  const atome = (): boolean => {
    const j = jetons[i++];
    if (j === "(") {
      const v = ou();
      if (jetons[i++] !== ")") throw new Error("parenthèse non fermée");
      return v;
    }
    if (j === undefined || j === ")" || j === "AND" || j === "OR") throw new Error("expression illisible");
    return ok(j);
  };
  try {
    const v = ou();
    return i === jetons.length && v;
  } catch {
    return false;
  }
}

export function verifierLicences(parLicence: Paquets, nomsMpl: Set<string>, nomsProduction: Set<string> = new Set()): string[] {
  const erreurs: string[] = [];
  for (const [licence, paquets] of Object.entries(parLicence)) {
    const ok = (id: string, nom: string) =>
      PERMISES.has(id) || (id === MPL && nomsMpl.has(nom)) || (EXCEPTIONS_DEV[nom] === id && !nomsProduction.has(nom));
    for (const p of paquets) {
      if (!expressionPermise(licence, (id) => ok(id, p.name))) erreurs.push(`${p.name} : licence « ${licence} » non permise`);
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
