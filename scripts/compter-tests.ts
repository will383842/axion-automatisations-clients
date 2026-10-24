import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Compteur de tests (C-538) : pas de baisse, pas de test sauté sans fiche, pas de relance pour les tests sensibles.

const SAUT = /\b(?:it|test|describe|bench)(?:\.\w+)*\.(?:skip|only|todo|skipIf|runIf)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|\bskip\s*:\s*true|\bctx\.skip\s*\(/;
const FICHE = /\/\/\s*fiche:\s*T\d+-\d+|\[V2\]/;
const FAILS = /\b(?:it|test)\.fails\s*\(/;
const SENSIBLE = /@(?:argent|isolation|anti-doublon|envoi)\b/;
const DEBUT_TEST = /\b(?:it|test|describe)(?:\.\w+)*\s*\(/;

export function compterRapport(rapport: { numTotalTests?: number }): number {
  return rapport.numTotalTests ?? 0;
}

export function verifierConsigne(consigne: number, actuel: number): string[] {
  return consigne === actuel ? [] : [`spec/compte-tests.json (${consigne}) doit égaler le compte réel (${actuel})`];
}

export function comparerCompte(actuel: number, reference: number): string[] {
  return actuel < reference ? [`le nombre de tests baisse : ${actuel} < ${reference}`] : [];
}

export function analyserSource(nom: string, texte: string): string[] {
  const lignes = texte.split("\n");
  const erreurs: string[] = [];
  lignes.forEach((l, i) => {
    const n = i + 1;
    if (SAUT.test(l) && !FICHE.test(l)) erreurs.push(`${nom}:${n}: test sauté sans « // fiche: T<lot>-<n> » ni [V2]`);
    if (FAILS.test(l) && !/@lot-\d+/.test(l)) erreurs.push(`${nom}:${n}: test.fails sans étiquette @lot-<n>`);
    if (DEBUT_TEST.test(l) && SENSIBLE.test(l)) {
      let fin = i + 1;
      while (fin < lignes.length && fin - i < 40 && !DEBUT_TEST.test(lignes[fin] ?? "")) fin++;
      if (lignes.slice(i, fin).some((x) => /\bretry\s*[:(]/.test(x))) {
        erreurs.push(`${nom}:${n}: retry interdit sur un test @argent, @isolation, @anti-doublon ou @envoi`);
      }
    }
  });
  return erreurs;
}

// Aucune configuration Vitest ne doit fixer un retry supérieur à 0.
export function analyserConfig(nom: string, texte: string): string[] {
  return texte
    .split("\n")
    .flatMap((l, i) => ((/\bretry\s*:\s*([^\s,}]+)/.exec(l)?.[1] ?? "0") !== "0" ? [`${nom}:${i + 1}: retry supérieur à 0 interdit`] : []));
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

// Usage : node scripts/compter-tests.ts <rapport-vitest.json>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const erreurs: string[] = [];
  const rapport = JSON.parse(readFileSync(process.argv[2] ?? "rapport-tests.json", "utf8"));
  const actuel = compterRapport(rapport);
  let reference = 0;
  try {
    reference = (JSON.parse(git("show", "origin/main:spec/compte-tests.json")) as { total: number }).total;
  } catch {
    console.error("origin/main sans spec/compte-tests.json : référence à 0");
  }
  erreurs.push(...comparerCompte(actuel, reference));
  const consigne = (JSON.parse(readFileSync("spec/compte-tests.json", "utf8")) as { total: number }).total;
  erreurs.push(...comparerCompte(consigne, reference).map((e) => `spec/compte-tests.json : ${e}`));
  erreurs.push(...verifierConsigne(consigne, actuel));
  const fichiers = git("ls-files", "*.test.ts", "*.test.tsx").split("\n").filter((f) => f && !f.includes("__fixtures__"));
  for (const f of fichiers) erreurs.push(...analyserSource(f, readFileSync(f, "utf8")));
  const configs = git("ls-files", "vitest.config.*", "**/vitest.config.*", "vitest.workspace.*", "**/vitest.workspace.*", "**/vitest.setup.*");
  for (const f of configs.split("\n").filter(Boolean)) erreurs.push(...analyserConfig(f, readFileSync(f, "utf8")));
  for (const e of erreurs) console.error(e);
  console.log(`tests : ${actuel} (référence ${reference})`);
  process.exit(erreurs.length ? 1 : 0);
}
