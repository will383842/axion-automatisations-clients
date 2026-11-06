// Liste des modèles d'IA admis (C-198), tenue par AXION IA : de la configuration, jamais un prix. Le choix d'un modèle ne sort jamais de cette liste.
// Un modèle est un code (« fournisseur/nom »), pas une clé étrangère : un modèle retiré de la liste fait échouer proprement le choix et l'appel.
export type ModeleAdmis = { code: string; fournisseur: string; horsUe: boolean };

export const FORME_MODELE = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;

// Mistral par défaut : le seul fournisseur de la liste dont le traitement reste dans l'UE.
export const MODELE_DEFAUT = "mistral/mistral-moyen";
export const MODELES_ADMIS: readonly ModeleAdmis[] = Object.freeze([
  { code: MODELE_DEFAUT, fournisseur: "mistral", horsUe: false },
  { code: "mistral/mistral-petit", fournisseur: "mistral", horsUe: false },
  { code: "anthropic/claude-moyen", fournisseur: "anthropic", horsUe: true },
  { code: "openai/gpt-moyen", fournisseur: "openai", horsUe: true },
]);

export type CodeErreurModele = "modele_non_admis" | "hors_ue_refuse" | "hors_manifeste";
export class ErreurModele extends Error {
  constructor(readonly code: CodeErreurModele) {
    super(code);
    this.name = "ErreurModele";
  }
}

export function modeleAdmis(code: unknown, liste: readonly ModeleAdmis[] = MODELES_ADMIS): ModeleAdmis | undefined {
  if (typeof code !== "string" || !FORME_MODELE.test(code) || code.includes("..")) return undefined;
  return liste.find((m) => m.code === code);
}

export function exigerModeleAdmis(code: unknown, liste: readonly ModeleAdmis[] = MODELES_ADMIS): ModeleAdmis {
  const m = modeleAdmis(code, liste);
  if (!m) throw new ErreurModele("modele_non_admis");
  return m;
}
