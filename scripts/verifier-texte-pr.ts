import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error TS5097 : l'extension .ts est nécessaire pour lancer ce fichier directement avec Node.
import { chargerListe, chercher, formaterTrouvailles } from "./garde-noms/chercher.ts";

// Titre et corps d'une PR, vérifiés AVANT « gh pr create » (C-611). Ne montre jamais le nom (C-531).
export function verifierTextePr(titre: string, corps: string, liste: Parameters<typeof chercher>[1]): string[] {
  return [...formaterTrouvailles("titre de la PR", chercher(titre, liste)), ...formaterTrouvailles("corps de la PR", chercher(corps, liste))];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [titre = "", fichierCorps = ""] = process.argv.slice(2);
  const { liste, refus, avertissement } = chargerListe(process.env);
  if (refus) {
    console.error(refus);
    process.exit(1);
  }
  if (avertissement) console.error(avertissement);
  const erreurs = verifierTextePr(titre, fichierCorps ? readFileSync(fichierCorps, "utf8") : "", liste);
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
