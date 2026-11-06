import type { Ligne } from "./lecteur.ts";

// Normalisation et dédoublonnage (A-273) : dans le fichier (mémoire) puis contre la base du client (port).
export const normaliserEmail = (v: string): string => v.trim().toLowerCase();
export const normaliserTelephone = (v: string): string => {
  const t = v.replace(/[^\d+]/g, "");
  return t.startsWith("00") ? `+${t.slice(2)}` : t;
};

// Clé d'une ligne : l'adresse e-mail, à défaut le téléphone ; sans l'un ni l'autre, pas de clé (la ligne n'est pas dédoublonnée).
export function cleDe(ligne: Ligne): string | undefined {
  const e = normaliserEmail(ligne["email"] ?? "");
  if (e) return e;
  const t = normaliserTelephone(ligne["telephone"] ?? "");
  return t ? `tel:${t}` : undefined;
}

export class Dedoublonneur {
  readonly #vues = new Set<string>();
  // existe : lecture dans la base de CE client seulement.
  constructor(private existe: (cle: string) => Promise<boolean>) {}
  async estDoublon(ligne: Ligne): Promise<boolean> {
    const cle = cleDe(ligne);
    if (cle === undefined) return false;
    if (this.#vues.has(cle)) return true;
    this.#vues.add(cle);
    return this.existe(cle);
  }
}
