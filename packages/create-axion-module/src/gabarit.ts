import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DOSSIER = fileURLToPath(new URL("../gabarit/", import.meta.url));
const SUFFIXE = ".modele";

// Fichiers du modèle, chemin relatif → contenu, avec le code du module à la place de __CODE__.
// Le suffixe .modele garde ces fichiers hors du lint, des types et des tests du dépôt.
export function fichiersDuGabarit(code: string, dossier = DOSSIER, prefixe = ""): Record<string, string> {
  const fichiers: Record<string, string> = {};
  for (const e of readdirSync(join(dossier, prefixe), { withFileTypes: true })) {
    const chemin = prefixe ? `${prefixe}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(fichiers, fichiersDuGabarit(code, dossier, chemin));
    else fichiers[chemin.slice(0, -SUFFIXE.length)] = readFileSync(join(dossier, chemin), "utf8").replaceAll("__CODE__", code);
  }
  return fichiers;
}
