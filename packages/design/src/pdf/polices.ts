import { Font } from "@react-pdf/renderer";
import { createRequire } from "node:module";

// Polices EMBARQUÉES depuis les fichiers des paquets @fontsource : aucune police de repli (C-597).
const exiger = createRequire(import.meta.url);
const fichier = (paquet: string, nom: string) => exiger.resolve(`@fontsource/${paquet}/files/${paquet}-latin-${nom}.woff`);

let declaree = false;
export function declarerPolices() {
  if (declaree) return;
  declaree = true;
  Font.register({
    family: "Manrope",
    fonts: [
      { src: fichier("manrope", "400-normal"), fontWeight: 400 },
      { src: fichier("manrope", "700-normal"), fontWeight: 700 },
      { src: fichier("manrope", "800-normal"), fontWeight: 800 },
    ],
  });
  Font.register({
    family: "Fraunces",
    fonts: [
      { src: fichier("fraunces", "600-normal"), fontWeight: 600 },
      { src: fichier("fraunces", "500-italic"), fontWeight: 500, fontStyle: "italic" },
    ],
  });
}
