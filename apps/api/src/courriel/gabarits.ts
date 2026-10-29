// Gabarits des e-mails de l'équipe. Chaque clé d'envoi a sa liste blanche de variables : rien d'autre n'entre dans le message (C-026).
// Les textes destinés aux clients arrivent avec le catalogue du lot 6 (T6-24), pas ici.

export interface Gabarit {
  variables: readonly string[];
  sujet(v: Record<string, string>): string;
  texte(v: Record<string, string>): string;
}

export const GABARITS: Readonly<Record<string, Gabarit>> = {
  // Alerte orange : client, automatisation et code d'erreur seulement (C-026).
  alerteOrange: {
    variables: ["client", "automatisation", "codeErreur"],
    sujet: (v) => `Alerte orange · ${v["client"]} · ${v["automatisation"]}`,
    texte: (v) => `Client : ${v["client"]}\nAutomatisation : ${v["automatisation"]}\nCode d'erreur : ${v["codeErreur"]}\n`,
  },
};

export class VariablesRefusees extends Error {}

// Les variables doivent être exactement celles de la liste blanche, d'une seule ligne : aucun en-tête ne peut s'y glisser.
export function rendre(cle: string, variables: Record<string, string>): { sujet: string; texte: string } | undefined {
  const g = Object.hasOwn(GABARITS, cle) ? GABARITS[cle] : undefined;
  if (!g) return undefined;
  const noms = Object.keys(variables).sort();
  if (noms.join("|") !== [...g.variables].sort().join("|")) throw new VariablesRefusees("variable hors de la liste blanche ou manquante");
  for (const n of noms) {
    const valeur = variables[n];
    if (typeof valeur !== "string" || valeur.length === 0 || valeur.length > 200 || /[\r\n\0]/.test(valeur)) throw new VariablesRefusees("variable invalide");
  }
  return { sujet: g.sujet(variables), texte: g.texte(variables) };
}
