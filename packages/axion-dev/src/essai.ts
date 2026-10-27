import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lancerJeuEssai } from "@axion-auto/harnais";
import type { defineAutomation } from "@axion-auto/sdk-module";

export type Module = ReturnType<typeof defineAutomation>;
export const FICHIER_MODULE = join("src", "module.ts");

// Le module exporte son manifeste (defineAutomation) et, pour l'essai, des réglages valides.
export async function chargerModule(dossier: string): Promise<{ module: Module; reglages: Record<string, unknown> }> {
  const charge = (await import(pathToFileURL(join(dossier, FICHIER_MODULE)).href)) as Record<string, unknown>;
  const module = Object.values(charge).find((v): v is Module => typeof v === "object" && v !== null && "schemaReglages" in v && "paquet" in v);
  if (!module) throw new Error(`${FICHIER_MODULE} n'exporte pas un manifeste produit par defineAutomation`);
  return { module, reglages: (charge["reglagesEssai"] as Record<string, unknown> | undefined) ?? { actionsAutomatiquesAutorisees: [] } };
}

// Un seul cas du jeu d'essai, sans e-mail piégé : étapes jouées, effets demandés, brouillons.
export async function essai(dossier: string, nom: string | undefined, ecrire: (texte: string) => void): Promise<number> {
  const { module, reglages } = await chargerModule(dossier);
  const cas = module.jeuEssai.find((c) => c.nom === nom);
  if (!cas) {
    ecrire(`cas introuvable : ${nom ?? "(--cas manquant)"}. Cas connus : ${module.jeuEssai.map((c) => c.nom).join(", ")}`);
    return 1;
  }
  const rapport = await lancerJeuEssai({ ...module, jeuEssai: [cas] }, { reglages, emails: [] });
  const [joue] = rapport.cas;
  ecrire(`cas : ${cas.nom} (${cas.categorie})`);
  ecrire(`étapes : ${module.etapes.map((e) => e.nom).join(", ")}`);
  ecrire(`effets demandés : ${rapport.hostile.appelsConnecteur} ; brouillons : ${rapport.hostile.demandes.brouillons}`);
  ecrire(joue?.reussi ? "1 cas joué : réussi" : `1 cas joué : échec — ${joue?.ecart ?? "écart inconnu"}`);
  return rapport.codeSortie;
}
