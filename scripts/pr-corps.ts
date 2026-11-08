import { fileURLToPath } from "node:url";

// Générateur de corps de PR conforme (règle 8 des routines) : première ligne « Exigences : … », puis les sections du modèle de PR.
// Usage (tant que « pnpm pr:corps » n'est pas dans la liste blanche de garde-licences) : node scripts/pr-corps.ts (--exigences A-018,B-225 | --aucune) --fait … --tests … --reste … [--fichier chemin]… > corps.md

const ID = /^[ABC]-\d{3}$/;
export const AUCUNE = "aucune (outillage)";

export type Entree = { exigences: string[]; fait: string; fichiers: string[]; tests: string; reste: string };

export function ligneExigences(ids: string[]): string {
  const vus = new Set<string>();
  for (const id of ids) {
    if (!ID.test(id)) throw new Error(`identifiant mal formé : « ${id} » (attendu A-123, B-123 ou C-123)`);
    if (vus.has(id)) throw new Error(`${id} : présent deux fois`);
    vus.add(id);
  }
  return `Exigences : ${ids.length === 0 ? AUCUNE : ids.join(", ")}`;
}

const exiger = (nom: string, valeur: string): string => {
  if (valeur.trim() === "") throw new Error(`« ${nom} » est vide`);
  return valeur.trim();
};

export function genererCorps(e: Entree): string {
  const ligne = ligneExigences(e.exigences);
  const fait = exiger("fait", e.fait);
  const tests = exiger("tests", e.tests);
  const reste = exiger("reste", e.reste);
  return [
    ligne,
    "",
    "## Ce qui est fait",
    fait,
    "",
    "## Exigences couvertes",
    e.exigences.length === 0 ? AUCUNE : e.exigences.join(", "),
    "",
    "## Fichiers touchés",
    ...(e.fichiers.length === 0 ? ["aucun"] : e.fichiers.map((f) => `- ${f}`)),
    "",
    "## Tests rouges puis verts",
    tests,
    "",
    "## Ce qui reste",
    reste,
    "",
    "## Contrôles",
    "- [ ] Aucun nom de client réel",
    "- [ ] Aucun prix",
    "- [ ] Aucun secret",
    "- [ ] Aucun extrait du cahier ni du juridique",
    "- [ ] Ni adresse IP ni nom d'hôte interne",
    "- [ ] PR de moins de 400 lignes hors tests et fichiers générés",
    "",
  ].join("\n");
}

const OPTIONS = new Set(["--exigences", "--fichier", "--fait", "--tests", "--reste"]);

export function analyserArguments(argv: string[]): Entree {
  const sortie: Entree = { exigences: [], fait: "", fichiers: [], tests: "", reste: "" };
  let choix = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--aucune") {
      choix = true;
      continue;
    }
    if (!OPTIONS.has(a)) throw new Error(`option inconnue : ${a}`);
    const valeur = argv[++i];
    if (valeur === undefined) throw new Error(`${a} demande une valeur`);
    if (a === "--exigences") {
      choix = true;
      sortie.exigences = valeur.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--fichier") sortie.fichiers.push(valeur);
    else if (a === "--fait") sortie.fait = valeur;
    else if (a === "--tests") sortie.tests = valeur;
    else sortie.reste = valeur;
  }
  if (!choix) throw new Error("préciser --exigences ou --aucune");
  return sortie;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(genererCorps(analyserArguments(process.argv.slice(2))));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
