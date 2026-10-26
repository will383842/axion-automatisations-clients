import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Garde « exigence sans test » (C-555, C-543). Le corps de PR est lu comme du texte, jamais exécuté.

export interface Exigence {
  id: string;
  lot: string;
  version: string;
  preuve: string;
}
export interface TestRapporte {
  nom: string;
  passe: boolean;
}
export interface Resultat {
  erreurs: string[];
  avertissements: string[];
  couverture: { id: string; preuve: string; tests: string[] }[];
}

const ID = /^[ABC]-\d{3}$/;
const ID_OUTILLAGE = /^LOT0-[A-Za-z0-9-]+$/;
const ETIQUETTE_LOT = /@lot-(\d+[a-z-]*)/;

interface Schema {
  items: { required: string[]; additionalProperties: boolean; properties: Record<string, { pattern?: string; enum?: string[] }> };
}

// Validation minimale du schéma spec/req-ids.schema.json : tableau, champs exacts, motif, énumération.
export function validerReqIds(donnees: unknown, schema: Schema): Exigence[] {
  if (!Array.isArray(donnees)) throw new Error("req-ids.json doit être un tableau");
  const { required, properties } = schema.items;
  donnees.forEach((e: unknown, i) => {
    if (typeof e !== "object" || e === null || Array.isArray(e)) throw new Error(`req-ids.json[${i}] doit être un objet`);
    const objet = e as Record<string, unknown>;
    for (const cle of Object.keys(objet)) if (!(cle in properties)) throw new Error(`req-ids.json[${i}] : champ en plus « ${cle} »`);
    for (const cle of required) {
      const v = objet[cle];
      const regle = properties[cle] ?? {};
      if (typeof v !== "string") throw new Error(`req-ids.json[${i}] : « ${cle} » manquant ou non textuel`);
      if (regle.pattern && !new RegExp(regle.pattern).test(v)) throw new Error(`req-ids.json[${i}] : « ${cle} » mal formé`);
      if (regle.enum && !regle.enum.includes(v)) throw new Error(`req-ids.json[${i}] : « ${cle} » hors liste`);
    }
  });
  return donnees as Exigence[];
}

interface SuitePlaywright {
  specs?: { title: string; ok?: boolean }[];
  suites?: SuitePlaywright[];
}

// Rapports Vitest JSON (testResults) et Playwright JSON (suites) : on lit les noms de tests, pas le texte des fichiers.
export function extraireTests(rapport: unknown): TestRapporte[] {
  const r = rapport as { testResults?: { assertionResults?: { fullName?: string; title?: string; status?: string }[] }[]; suites?: SuitePlaywright[] };
  const sortie: TestRapporte[] = [];
  for (const fichier of r.testResults ?? []) {
    for (const a of fichier.assertionResults ?? []) sortie.push({ nom: a.fullName ?? a.title ?? "", passe: a.status === "passed" });
  }
  const parcourir = (suites: SuitePlaywright[]) => {
    for (const s of suites) {
      for (const spec of s.specs ?? []) sortie.push({ nom: spec.title, passe: spec.ok === true });
      parcourir(s.suites ?? []);
    }
  };
  parcourir(r.suites ?? []);
  return sortie;
}

export function lireLigneExigences(corps: string): string | null {
  for (const ligne of corps.split(/\r?\n/)) {
    const m = /^\s*Exigences\s*:\s*(.*?)\s*$/.exec(ligne);
    if (m) return m[1] ?? "";
  }
  return null;
}

const porteId = (nom: string, id: string) => nom.includes(`[${id}]`);

export function verifierCouverture(entree: { reqs: Exigence[]; corps: string; tests: TestRapporte[]; preuves: string }): Resultat {
  const { reqs, corps, tests, preuves } = entree;
  const res: Resultat = { erreurs: [], avertissements: [], couverture: [] };
  // `spec/preuves.md` est fusionné en union (ADR 0029) : deux branches qui prouvent le même numéro donnent un doublon, refusé ici.
  const vus = new Set<string>();
  for (const [, id] of preuves.matchAll(/^([ABC]-\d{3})\s*→/gm)) {
    if (id && vus.has(id)) res.erreurs.push(`${id} : présent deux fois dans spec/preuves.md`);
    vus.add(id ?? "");
  }
  const ligne = lireLigneExigences(corps);
  if (ligne === null) {
    res.erreurs.push("ligne Exigences absente (écrire « Exigences : C-123 » ou « Exigences : aucune (outillage) »)");
    return res;
  }
  if (ligne !== "aucune (outillage)") {
    const ids = ligne.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) res.erreurs.push("ligne Exigences vide");
    for (const id of ids) {
      if (ID_OUTILLAGE.test(id)) continue; // identifiant technique : aucune exigence, aucune couverture
      if (!ID.test(id)) {
        res.erreurs.push("identifiant mal formé dans la ligne Exigences");
        continue;
      }
      const req = reqs.find((r) => r.id === id);
      if (!req) {
        res.erreurs.push(`exigence inconnue : ${id}`);
        continue;
      }
      const trouves: string[] = [];
      if (req.preuve.includes("test") || req.preuve === "e2e") {
        const candidats = tests.filter((t) => porteId(t.nom, id) && t.passe);
        // Un test attendu rouge (@lot-<n> du lot de l'exigence) ne prouve rien pour une exigence V1.
        const valables = candidats.filter((t) => req.version === "V2" || ETIQUETTE_LOT.exec(t.nom)?.[1] !== req.lot);
        trouves.push(...valables.map((t) => t.nom));
        if (trouves.length === 0) res.erreurs.push(`${id} : aucun test vert portant [${id}] (un test attendu rouge ne compte pas)`);
      }
      if (/document|exercice|mesure/.test(req.preuve)) {
        if (new RegExp(`^${id}\\s*→`, "m").test(preuves)) trouves.push("spec/preuves.md");
        else res.erreurs.push(`${id} : ligne absente de spec/preuves.md`);
      }
      res.couverture.push({ id, preuve: req.preuve, tests: trouves });
    }
  }
  for (const req of reqs.filter((r) => r.version === "V2")) {
    if (tests.some((t) => porteId(t.nom, req.id))) res.avertissements.push(`${req.id} : test portant une exigence V2, à vérifier par le gardien`);
  }
  return res;
}

// Usage : CORPS_PR="…" node scripts/couverture-req.ts <rapport.json>...
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lire = (chemin: string) => readFileSync(chemin, "utf8");
  const schema = JSON.parse(lire("spec/req-ids.schema.json")) as Schema;
  const reqs = validerReqIds(JSON.parse(lire("spec/req-ids.json")), schema);
  const tests = process.argv.slice(2).filter(existsSync).flatMap((f) => extraireTests(JSON.parse(lire(f))));
  const preuves = existsSync("spec/preuves.md") ? lire("spec/preuves.md") : "";
  const res = verifierCouverture({ reqs, corps: process.env["CORPS_PR"] ?? "", tests, preuves });
  for (const c of res.couverture) console.log(`${c.id} → ${c.tests.join(", ")}`);
  for (const a of res.avertissements) console.warn(`avertissement : ${a}`);
  for (const e of res.erreurs) console.error(e);
  writeFileSync("rapport-couverture.json", JSON.stringify(res, null, 2));
  process.exit(res.erreurs.length ? 1 : 0);
}
