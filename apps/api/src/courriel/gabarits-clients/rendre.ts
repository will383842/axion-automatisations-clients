import type { TexteEmail } from "../../../../../packages/contrats/src/messages/catalogue.js";

// Rendu des e-mails des clients à liste blanche : variables exactement celles du texte, d'une ligne, 1 à 200 caractères,
// liens limités à l'origine du portail, remplacement littéral (jamais de motif de remplacement).

export class RenduRefuse extends Error {}

export interface OptionsRendu { originePortail?: string }

function origine(valeur: string): string | undefined {
  try {
    const u = new URL(valeur);
    return u.username === "" && u.password === "" && (u.protocol === "https:" || u.protocol === "http:") ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

export function rendreClient(texte: TexteEmail, variables: Record<string, string>, o: OptionsRendu): { sujet: string; texte: string } {
  const noms = Object.keys(variables).sort();
  if (noms.join("|") !== [...texte.variables].sort().join("|")) throw new RenduRefuse("variable hors de la liste blanche ou manquante");
  const attendue = o.originePortail === undefined ? undefined : origine(o.originePortail);
  for (const n of noms) {
    const v = variables[n];
    // eslint-disable-next-line no-control-regex
    if (typeof v !== "string" || v.length === 0 || v.length > 200 || /[\u0000-\u001f\u007f]/.test(v)) throw new RenduRefuse("variable invalide");
    if (n.startsWith("lien") && (attendue === undefined || origine(v) !== attendue)) throw new RenduRefuse("lien hors de l'origine du portail");
  }
  const remplir = (s: string) => s.replace(/\{([A-Za-z0-9]+)\}/g, (m, nom: string) => (Object.hasOwn(variables, nom) ? (variables[nom] as string) : m));
  return { sujet: remplir(texte.sujet), texte: remplir(texte.corps) };
}
