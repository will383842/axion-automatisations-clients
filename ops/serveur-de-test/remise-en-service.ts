// Mesure de la remise en service (C-044) : de la coupure au premier « service rendu », en secondes d'époque, face à la limite de 4 h.
// Usage : node remise-en-service.ts <coupure> <service rendu>   (affiche la ligne à consigner ; code 1 si la limite est dépassée)
import { pathToFileURL } from "node:url";

export const LIMITE_S = 4 * 3600;
const duree = (s: number) => `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;

export function mesurerRemiseEnService(coupureS: number, serviceS: number, limiteS = LIMITE_S) {
  if (![coupureS, serviceS].every((n) => Number.isFinite(n) && n > 0)) throw new Error("dates de coupure et de service rendu obligatoires");
  if (serviceS < coupureS) throw new Error("le service rendu précède la coupure");
  const dureeS = serviceS - coupureS;
  const respecte = dureeS <= limiteS;
  const ligne = respecte
    ? `Remise en service : ${duree(dureeS)} pour une limite de ${duree(limiteS)} : respectée`
    : `Remise en service : ${duree(dureeS)} : dépasse la limite de ${duree(limiteS)} de ${duree(dureeS - limiteS)}`;
  return { dureeS, respecte, ligne };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const m = mesurerRemiseEnService(Number(process.argv[2]), Number(process.argv[3]));
    console.log(m.ligne);
    process.exit(m.respecte ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "erreur");
    process.exit(2);
  }
}
