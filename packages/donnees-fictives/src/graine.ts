// Générateur pseudo-aléatoire à graine (mulberry32) : même graine → même suite, à l'octet près.

export type Generateur = {
  suivant(): number;
  entier(min: number, max: number): number;
  choisir<T>(liste: readonly T[]): T;
  chiffres(n: number): string;
};

function hacher(graine: number | string): number {
  let h = 2166136261;
  for (const c of String(graine)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function creerGenerateur(graine: number | string): Generateur {
  let etat = hacher(graine);
  const suivant = (): number => {
    etat = (etat + 0x6d2b79f5) >>> 0;
    let t = etat;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const entier = (min: number, max: number) => min + Math.floor(suivant() * (max - min + 1));
  return {
    suivant,
    entier,
    choisir: <T>(liste: readonly T[]): T => liste[entier(0, liste.length - 1)] as T,
    chiffres: (n) => Array.from({ length: n }, () => entier(0, 9)).join(""),
  };
}
