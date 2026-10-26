import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

// Compteur de tests (C-538) : pas de baisse par fichier (mesurée par la CI sur le commit de base, ADR 0019), pas de test sauté sans fiche, pas de relance pour les tests sensibles.

const SAUT = /\b(?:it|test|describe|bench)(?:\.\w+)*\.(?:skip|only|todo|skipIf|runIf)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|\bskip\s*:\s*true|\bctx\.skip\s*\(/;
const FICHE = /\/\/\s*fiche:\s*T\d+-\d+|\[V2\]/;
const FAILS = /\b(?:it|test)\.fails\s*\(/;
const SENSIBLE = /@(?:argent|isolation|anti-doublon|envoi)\b/;
const DEBUT_TEST = /\b(?:it|test|describe)(?:\.\w+)*\s*\(/;

export function compterRapport(rapport: { numTotalTests?: number }): number {
  return rapport.numTotalTests ?? 0;
}

// Nombre de tests par fichier, chemins relatifs à la racine du dépôt.
export type Liste = Record<string, number>;
// Baisse justifiée, déclarée dans spec/retraits/<id-fiche>.json par la PR qui la porte.
export interface Retrait { fichier: string; avant: number; apres: number; raison: string }

// Lit la sortie de « vitest list --json » : [{ name, file }].
export function lireListe(json: unknown, racine: string): Liste {
  if (!Array.isArray(json)) throw new Error("la liste de vitest n'est pas un tableau");
  const liste: Liste = {};
  for (const e of json as { file?: unknown }[]) {
    if (typeof e?.file !== "string") throw new Error("entrée de la liste de vitest sans fichier");
    const f = relative(racine, e.file);
    liste[f] = (liste[f] ?? 0) + 1;
  }
  return liste;
}

export function lireRetrait(nom: string, texte: string): { retrait?: Retrait; erreurs: string[] } {
  let v: Record<string, unknown>;
  try {
    v = (JSON.parse(texte) ?? {}) as Record<string, unknown>;
  } catch {
    return { erreurs: [`${nom} : JSON illisible`] };
  }
  const { fichier, avant, apres, raison } = v;
  const ok =
    typeof v === "object" && Object.keys(v).length === 4 && typeof fichier === "string" && fichier !== "" && Number.isInteger(avant) && Number.isInteger(apres) && (apres as number) < (avant as number) && (apres as number) >= 0 && typeof raison === "string" && raison.trim() !== "";
  return ok ? { retrait: { fichier, avant, apres, raison } as Retrait, erreurs: [] } : { erreurs: [`${nom} : attendu { fichier, avant, apres, raison } avec apres < avant et une raison`] };
}

// Une baisse dans un fichier (fichier supprimé ou renommé compris, apres = 0) doit être déclarée avec les nombres mesurés exacts.
export function comparerParFichier(base: Liste, pr: Liste, retraits: Retrait[]): string[] {
  const erreurs: string[] = [];
  for (const [fichier, avant] of Object.entries(base)) {
    const apres = pr[fichier] ?? 0;
    if (apres >= avant) continue;
    const r = retraits.find((x) => x.fichier === fichier);
    if (!r) erreurs.push(`${fichier} : ${apres} tests < ${avant} sur la base, sans déclaration dans spec/retraits/`);
    else if (r.avant !== avant || r.apres !== apres) erreurs.push(`${fichier} : déclaration ${r.avant} → ${r.apres}, mesure ${avant} → ${apres}`);
  }
  return erreurs;
}

// Nombre de tests par fichier du rapport Vitest JSON : les tests sautés ou à faire y comptent, comme dans le total d'avant.
export function lireRapportFichiers(rapport: { testResults?: { name: string; assertionResults?: unknown[] }[] }, racine: string): Liste {
  const liste: Liste = {};
  for (const r of rapport.testResults ?? []) {
    const n = r.assertionResults?.length ?? 0;
    if (n > 0) liste[relative(racine, r.name)] = n;
  }
  return liste;
}

// Tout test listé doit figurer dans le rapport : un test listé mais non lancé (filtré par la configuration) fait échouer la garde.
// Le rapport peut en compter davantage : « vitest list » ne liste pas les tests sautés ni à faire.
export function verifierExecutes(liste: Liste, rapport: Liste): string[] {
  return Object.entries(liste)
    .filter(([f, n]) => (rapport[f] ?? 0) < n)
    .map(([f, n]) => `${f} : ${n} tests listés mais ${rapport[f] ?? 0} dans le rapport`);
}

// Sortie de « git diff --name-status » : seules les déclarations AJOUTÉES par la PR comptent, jamais une ancienne ni une modifiée.
export function fichiersDeclares(sortie: string): string[] {
  return sortie
    .split("\n")
    .map((l) => l.split("\t"))
    .filter(([s, f]) => s === "A" && /^spec\/retraits\/[^/]+\.json$/.test(f ?? ""))
    .map(([, f]) => f as string);
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

// Options : --rapport <fichier> (rapport Vitest JSON), --projet integration, --base-ref <commit> (HEAD^1 par défaut). Un premier argument seul reste le rapport.
export function analyserArguments(argv: string[]): { rapport: string; projet: string | undefined; baseRef: string } {
  const sortie = { rapport: "rapport-tests.json", projet: undefined as string | undefined, baseRef: "HEAD^1" };
  const cle = { "--rapport": "rapport", "--projet": "projet", "--base-ref": "baseRef" } as const;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a in cle) {
      const valeur = argv[++i];
      if (!valeur || valeur.startsWith("--")) throw new Error(`${a} demande une valeur`);
      sortie[cle[a as keyof typeof cle]] = valeur;
    } else if (!a.startsWith("--") && i === 0) sortie.rapport = a;
    else throw new Error(`argument inconnu : ${a}`);
  }
  return sortie;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function vitest(dossier: string, args: string[], projet: string | undefined): string {
  const env = { ...process.env, ...(projet === "integration" ? { SOCLE_INTEGRATION: "1" } : {}) };
  return execFileSync("pnpm", ["exec", "vitest", ...args, ...(projet ? ["--project", projet] : [])], { cwd: dossier, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
}

// Liste des tests sans les lancer (le projet integration se collecte sans socle).
function lister(dossier: string, projet: string | undefined): Liste {
  const sortie = vitest(dossier, ["list", "--json"], projet);
  return lireListe(JSON.parse(sortie.slice(sortie.indexOf("["))), dossier);
}

// Base : le projet integration demande le socle, il se compte par la liste ; les autres projets se lancent, pour compter les tests sautés comme le rapport de la PR.
function mesurerBase(dossier: string, projet: string | undefined): Liste {
  if (projet) return lister(dossier, projet);
  const sortie = `${dossier}/rapport-base.json`;
  try {
    vitest(dossier, ["run", "--reporter=json", `--outputFile=${sortie}`], projet);
  } catch {
    // Un échec de la base se lit dans son rapport : le compte reste mesurable.
  }
  return lireRapportFichiers(JSON.parse(readFileSync(sortie, "utf8")), dossier);
}

// Usage : node scripts/compter-tests.ts [<rapport-vitest.json>] [--rapport <fichier>] [--projet integration] [--base-ref <commit>]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const erreurs: string[] = [];
  const options = analyserArguments(process.argv.slice(2));
  const rapport = JSON.parse(readFileSync(options.rapport, "utf8"));
  const racine = process.cwd();
  const execute = lireRapportFichiers(rapport, racine);
  const liste = lister(racine, options.projet);
  erreurs.push(...verifierExecutes(liste, execute));
  const pr = options.projet ? liste : execute;
  // Base mesurée dans le même job, sur un worktree du commit de base : aucun total n'est écrit dans le dépôt.
  const copie = mkdtempSync(`${tmpdir()}/base-`);
  let base: Liste = {};
  try {
    git("worktree", "add", "--detach", copie, options.baseRef);
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--offline"], { cwd: copie, stdio: "inherit" });
    base = mesurerBase(copie, options.projet);
  } catch (e) {
    erreurs.push(`base ${options.baseRef} non mesurée : ${(e as Error).message}`);
  } finally {
    try {
      git("worktree", "remove", "--force", copie);
    } catch {
      rmSync(copie, { recursive: true, force: true });
    }
  }
  const retraits: Retrait[] = [];
  for (const f of fichiersDeclares(git("diff", "--name-status", options.baseRef, "HEAD", "--", "spec/retraits"))) {
    const lu = lireRetrait(f, git("show", `HEAD:${f}`));
    erreurs.push(...lu.erreurs);
    if (lu.retrait) retraits.push(lu.retrait);
  }
  erreurs.push(...comparerParFichier(base, pr, retraits));
  const fichiers = git("ls-files", "*.test.ts", "*.test.tsx").split("\n").filter((f) => f && !f.includes("__fixtures__"));
  for (const f of fichiers) erreurs.push(...analyserSource(f, readFileSync(f, "utf8")));
  const configs = git("ls-files", "vitest.config.*", "**/vitest.config.*", "**/vitest.setup.*");
  for (const f of configs.split("\n").filter(Boolean)) erreurs.push(...analyserConfig(f, readFileSync(f, "utf8")));
  for (const e of erreurs) console.error(e);
  const somme = (l: Liste) => Object.values(l).reduce((s, n) => s + n, 0);
  console.log(`tests : ${somme(pr)} (base ${somme(base)})`);
  process.exit(erreurs.length ? 1 : 0);
}
