import type { Generateur } from "./graine.js";

// SIREN et SIRET GÉNÉRÉS : jamais vérifiés auprès d'un registre, jamais associés à une vraie raison sociale.

export function luhnValide(chiffres: string): boolean {
  if (!/^\d+$/.test(chiffres)) return false;
  let somme = 0;
  [...chiffres].reverse().forEach((c, i) => {
    let d = Number(c);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    somme += d;
  });
  return somme % 10 === 0;
}

// Complète un préfixe par le dernier chiffre qui rend le numéro valide.
function avecCle(prefixe: string): string {
  for (let k = 0; k < 10; k++) if (luhnValide(prefixe + k)) return prefixe + k;
  throw new Error("clé de Luhn introuvable");
}

export const genererSiren = (g: Generateur): string => avecCle(String(g.entier(1, 9)) + g.chiffres(7));
export const genererSiret = (g: Generateur, siren: string = genererSiren(g)): string => avecCle(siren + g.chiffres(4));
