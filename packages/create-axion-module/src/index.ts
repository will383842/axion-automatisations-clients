#!/usr/bin/env tsx
import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineAutomation } from "@axion-auto/sdk-module";
import { manifesteExemple } from "@axion-auto/sdk-module/exemples/module-exemple.ts";
import { fichiersDuGabarit } from "./gabarit.ts";

// Même règle que defineAutomation : un code propre à un client est refusé avant d'écrire quoi que ce soit.
function verifierCode(code: string): void {
  try {
    defineAutomation({ ...manifesteExemple, code });
  } catch (e) {
    throw new Error(`code refusé : ${(e as Error).message.replace(/^manifeste refusé : /, "")}`);
  }
}

export async function creerModule(code: string, racine: string): Promise<string> {
  verifierCode(code);
  const dossier = join(racine, "modules", code);
  if (existsSync(dossier)) throw new Error(`le dossier modules/${code} existe déjà`);
  for (const [chemin, contenu] of Object.entries(fichiersDuGabarit(code))) {
    await mkdir(dirname(join(dossier, chemin)), { recursive: true });
    await writeFile(join(dossier, chemin), contenu, { flag: "wx" });
  }
  return dossier;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const code = process.argv[2];
  if (!code) {
    console.error("usage : pnpm creer-module <code>");
    process.exit(1);
  }
  creerModule(code, process.cwd()).then(
    (d) => console.log(`module créé dans ${d} ; après « pnpm install », lancer « pnpm test:module » dans ce dossier pour l'essayer`),
    (e: Error) => (console.error(e.message), process.exit(1)),
  );
}
