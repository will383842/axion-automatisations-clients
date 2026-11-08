import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Vérification complète en local : « pnpm verifier » puis les contrôles de la CI (compter-tests, licences, garde-workflows), dans leur forme exacte.
// Usage (tant que « pnpm verifier:complet » n'est pas dans la liste blanche de garde-licences) : node scripts/verifier-complet.ts
// Arrêt à la première étape en échec. Aucune garde n'est contournée ni assouplie.

export type Etape = { nom: string; commande: string; args: string[] };

export function etapes(): Etape[] {
  return [
    { nom: "verifier", commande: "pnpm", args: ["verifier"] },
    { nom: "tests-rapport", commande: "pnpm", args: ["test:compter"] },
    { nom: "compter-tests", commande: "node", args: ["scripts/compter-tests.ts", "--rapport", "rapport-tests.json", "--base-ref", "origin/main"] },
    { nom: "licences", commande: "node", args: ["scripts/garde-licences.ts"] },
    { nom: "garde-workflows", commande: "node", args: ["scripts/garde-workflows.ts", ".github/workflows"] },
  ];
}

export function lancer(liste: Etape[], executer: (e: Etape) => number): number {
  for (const e of liste) {
    const code = executer(e);
    if (code !== 0) return code;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = lancer(etapes(), (e) => {
    console.log(`\n== ${e.nom} : ${[e.commande, ...e.args].join(" ")}`);
    return spawnSync(e.commande, e.args, { stdio: "inherit" }).status ?? 1;
  });
  rmSync("rapport-tests.json", { force: true }); // rapport temporaire, non versionné
  process.exit(code);
}
