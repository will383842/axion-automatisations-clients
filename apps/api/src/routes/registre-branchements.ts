import { readdirSync } from "node:fs";
import type { Branchement } from "./branchement.js";

// Le dossier routes/branchements/ est lu à l'exécution, trié par nom (sans locale : ordre déterministe). Un fichier hors forme ou mal formé fait ÉCHOUER le chargement, il n'est jamais ignoré (ADR 0139).
// Les fichiers de branchement n'importent jamais ce fichier : le top-level await bloquerait le chargement.
const NOM = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:ts|js)$/;
const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function validerBranchements(entrees: { nom: string; module: unknown }[]): readonly Branchement[] {
  if (entrees.length === 0) throw new Error("registre des branchements vide");
  const cles = new Map<string, string>();
  const rendus = [...entrees].sort((a, b) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0)).map(({ nom, module }) => {
    if (!NOM.test(nom)) throw new Error(`branchement refusé : nom « ${nom} » hors forme`);
    const b = estObjet(module) ? module["default"] : undefined;
    if (!estObjet(b) || typeof b["lister"] !== "function") throw new Error(`branchement ${nom} : export par défaut sans fonction lister`);
    const sv = b["serveur"];
    if (sv !== undefined) {
      const ok = estObjet(sv) && typeof sv["brancher"] === "function" && (sv["toujours"] === true || (typeof sv["cle"] === "string" && sv["cle"] !== ""));
      if (!ok) throw new Error(`branchement ${nom} : serveur mal formé`);
      if (typeof sv["cle"] === "string") {
        const autre = cles.get(sv["cle"]);
        if (autre) throw new Error(`branchement ${nom} : clé « ${sv["cle"]} » déjà déclarée par ${autre}`);
        cles.set(sv["cle"], nom);
      }
    }
    return Object.freeze(b as unknown as Branchement);
  });
  return Object.freeze(rendus);
}

const DOSSIER = new URL("./branchements/", import.meta.url);
const noms = readdirSync(DOSSIER).sort();
export const NOMS_BRANCHEMENTS: readonly string[] = Object.freeze(noms);
export const BRANCHEMENTS = validerBranchements(await Promise.all(noms.map(async (nom) => ({ nom, module: NOM.test(nom) ? await import(new URL(nom, DOSSIER).href) : undefined }))));
