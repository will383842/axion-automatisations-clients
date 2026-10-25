import { COMPOSANTS } from "./composants.ts";

export type ErreurEcran = { chemin: string; code: string; message: string };
const PROFONDEUR_MAX = 8;
const LONGUEUR_MAX = 2000;
const BALISE = /<\s*\/?\s*[a-z!?]/;
const GESTIONNAIRE = /(?:^|[^a-z])on[a-z]{3,}\s*=/;
const CODE = /\$\{|\{\{|`|=>|\beval\s*\(|\bfunction\s*\(/;
const ENTITE = /&#x?[0-9a-f]+;?|&(?:colon|tab|newline|lpar|rpar);/;
const SCHEMA = /(?:^|[^a-z])(?:javascript|vbscript|data)\s*:/;
const CLE_CODE = /^(?:on[a-z]+|__proto__|constructor|prototype)$/i;

function codeDans(texte: string): boolean {
  let t = texte.normalize("NFKC").toLowerCase();
  try {
    t = decodeURIComponent(t);
  } catch {
    /* texte non encodé : on garde tel quel */
  }
  const compact = t.replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "");
  return BALISE.test(t) || GESTIONNAIRE.test(t) || CODE.test(t) || ENTITE.test(t) || SCHEMA.test(compact);
}

function parcourir(v: unknown, chemin: string, profondeur: number, vus: Set<object>, sortie: ErreurEcran[]): void {
  const err = (code: string, message: string) => sortie.push({ chemin, code, message });
  if (typeof v === "string") {
    if (v.length > LONGUEUR_MAX) err("ecran.texte_trop_long", "Ce texte est trop long.");
    else if (codeDans(v)) err("ecran.code_interdit", "Un écran décrit des textes, jamais du code, des balises ou des liens javascript.");
  } else if (v === null || typeof v === "number" || typeof v === "boolean") return;
  else if (typeof v !== "object") err("ecran.valeur_interdite", "Cette valeur n'est pas une donnée simple.");
  else if (vus.has(v)) err("ecran.cycle", "Cet écran se référence lui-même.");
  else if (profondeur > PROFONDEUR_MAX) err("ecran.trop_profond", "Cet écran est trop imbriqué.");
  else {
    vus.add(v);
    for (const [k, x] of Object.entries(v)) {
      const ici = chemin ? `${chemin}.${k}` : k;
      if (CLE_CODE.test(k) || codeDans(k)) sortie.push({ chemin: ici, code: "ecran.code_interdit", message: "Ce nom de propriété est interdit dans un écran." });
      else parcourir(x, ici, profondeur + 1, vus, sortie);
    }
    vus.delete(v);
  }
}

// B-170, B-171 : vérifie les écrans déclarés par un module.
export function validerEcrans(ecrans: unknown): { ok: boolean; erreurs: ErreurEcran[] } {
  const erreurs: ErreurEcran[] = [];
  if (!Array.isArray(ecrans)) return { ok: false, erreurs: [{ chemin: "(racine)", code: "ecran.liste_attendue", message: "Les écrans doivent être une liste." }] };
  ecrans.forEach((e: unknown, i) => {
    const avant = erreurs.length;
    parcourir(e, String(i), 0, new Set(), erreurs);
    if (erreurs.length > avant) return;
    const { composant, proprietes } = (e ?? {}) as { composant?: unknown; proprietes?: unknown };
    if (typeof composant !== "string" || !Object.hasOwn(COMPOSANTS, composant)) {
      erreurs.push({ chemin: `${i}.composant`, code: "ecran.composant_inconnu", message: "Ce composant n'existe pas dans la liste des composants standards." });
      return;
    }
    const lecture = COMPOSANTS[composant as keyof typeof COMPOSANTS].safeParse(proprietes);
    if (!lecture.success) {
      for (const p of lecture.error.issues) erreurs.push({ chemin: [i, "proprietes", ...p.path].join("."), code: "ecran.propriete_invalide", message: "Cette propriété est inconnue, du mauvais type ou hors de la liste admise." });
    }
  });
  return { ok: erreurs.length === 0, erreurs };
}
