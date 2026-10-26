#!/usr/bin/env tsx
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emballer } from "./emballer.ts";
import { essai } from "./essai.ts";
import { publier } from "./publier.ts";
import { test } from "./test.ts";

export interface Contexte {
  cwd: string;
  env: Record<string, string | undefined>;
  ecrire: (texte: string) => void;
  recetteConfiguree?: string;
  fetch?: typeof fetch;
}

// Codes de sortie : 0 réussi, 1 test échoué, 2 refus de l'emballage, 3 envoi refusé.
export async function executer(argv: string[], c: Contexte): Promise<number> {
  const [commande, ...reste] = argv;
  try {
    if (commande === "test") return await test(c.cwd, c.ecrire);
    if (commande === "essai") return await essai(c.cwd, reste[reste.indexOf("--cas") + 1], c.ecrire);
    if (commande === "emballer") return await emballer(c.cwd, c.ecrire);
    if (commande === "publier") return await publier(c.cwd, { env: c.env, recette: reste.includes("--recette"), recetteConfiguree: c.recetteConfiguree ?? c.env["AXION_RECETTE_ORIGINE"], fetch: c.fetch ?? fetch }, c.ecrire);
  } catch (e) {
    c.ecrire(`erreur : ${(e as Error).message}`);
    return commande === "publier" ? 3 : commande === "emballer" ? 2 : 1;
  }
  c.ecrire("usage : axion-dev essai --cas <nom> | test | emballer | publier --recette");
  return 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await executer(process.argv.slice(2), { cwd: process.cwd(), env: process.env, ecrire: console.log });
}
