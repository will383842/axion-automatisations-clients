import { z } from "zod";
import type { defineAutomation } from "../manifeste.ts";
import { deballer } from "./options.ts";
import { trouverEnClair } from "./references.ts";

export type ModuleSdk = ReturnType<typeof defineAutomation>;
export type ErreurChamp = { champ: string; code: string; message: string };
export type Reglages = Readonly<Record<string, unknown>>;
export type ResultatReglages = { ok: true; valeurs: Reglages } | { ok: false; erreurs: ErreurChamp[] };

export const estObjet = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

export function figerProfond<T>(v: T): T {
  if (v && typeof v === "object") for (const x of Object.values(v)) figerProfond(x);
  return v && typeof v === "object" ? Object.freeze(v) : v;
}

// B-091 : aucune valeur inconnue, à aucun niveau (les objets Zod ordinaires les ignoreraient en silence).
function inconnus(schema: z.ZodType, valeur: unknown, chemin: string, sortie: ErreurChamp[]): void {
  const s = deballer(schema);
  if (s instanceof z.ZodObject && estObjet(valeur)) {
    for (const [k, v] of Object.entries(valeur)) {
      const ici = chemin ? `${chemin}.${k}` : k;
      const champ = Object.hasOwn(s.shape, k) ? (s.shape[k] as z.ZodType) : undefined;
      if (champ) inconnus(champ, v, ici, sortie);
      else sortie.push({ champ: ici, code: "reglage.inconnu", message: `Le réglage « ${ici} » n'existe pas pour cette automatisation.` });
    }
  }
}

const ATTENDU: Record<string, string> = { string: "du texte", number: "un nombre", boolean: "oui ou non", array: "une liste", object: "un groupe de réglages" };
const lire = (v: unknown, chemin: PropertyKey[]) => chemin.reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<PropertyKey, unknown>)[k] : undefined), v);

function message(i: z.core.$ZodIssue, valeur: unknown): string {
  if (i.code === "invalid_type") return lire(valeur, i.path) === undefined ? "Ce réglage est obligatoire." : `Ce réglage doit être ${ATTENDU[i.expected] ?? "d'un autre type"}.`;
  if (i.code === "too_small") return "Cette valeur est trop petite ou trop courte.";
  if (i.code === "too_big") return "Cette valeur est trop grande ou trop longue.";
  if (i.code === "invalid_value") return "Cette valeur n'est pas dans la liste admise.";
  return "Cette valeur n'est pas valide.";
}

export function validerReglages(module: Pick<ModuleSdk, "reglages">, valeurs: unknown): ResultatReglages {
  if (!estObjet(valeurs)) return { ok: false, erreurs: [{ champ: "(racine)", code: "reglage.invalide", message: "Les réglages doivent être un groupe de valeurs." }] };
  const erreurs: ErreurChamp[] = [];
  inconnus(module.reglages, valeurs, "", erreurs);
  const lecture = module.reglages.safeParse(valeurs);
  if (!lecture.success) {
    for (const i of lecture.error.issues) erreurs.push({ champ: i.path.join(".") || "(racine)", code: "reglage.invalide", message: message(i, valeurs) });
  }
  for (const champ of trouverEnClair(lecture.success ? lecture.data : valeurs)) {
    erreurs.push({ champ, code: "reglage.valeur_en_clair", message: "Mettez une référence de connexion (connexion:<famille>), pas une adresse, un mot de passe ou un jeton." });
  }
  return erreurs.length ? { ok: false, erreurs } : { ok: true, valeurs: figerProfond(lecture.data as Record<string, unknown>) };
}
