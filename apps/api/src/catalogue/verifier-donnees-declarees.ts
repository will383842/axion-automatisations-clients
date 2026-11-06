import { Donnees } from "../../../../packages/contrats/src/c4/donnees.ts";
import { MODELE_BASE_CLIENT, verifierForme, type Modele } from "@axion-auto/donnees-module";

// Import d'une version (T4-50c, ADR 0109, ADR 0112) : les requêtes déclarées du manifeste sont lues en C4 0.5.0 (schémas des contrats), puis chaque forme est vérifiée
// par le paquet donnees-module contre le modèle des bases clients. Rien n'est recopié. Un manifeste sans `donnees` est accepté. Échec fermé : le moindre refus, ou une exception, refuse tout.
// Rend les messages de refus (vide = accepté) ; ils ne citent que des noms déjà validés par les schémas, jamais une valeur brute du module.
const MAX_MESSAGES = 5;

export function verifierDonneesDeclarees(manifeste: Record<string, unknown>, modele: Modele = MODELE_BASE_CLIENT): string[] {
  if (!Object.hasOwn(manifeste, "donnees") || manifeste["donnees"] === undefined) return [];
  try {
    const lu = Donnees.safeParse(manifeste["donnees"]);
    if (!lu.success) return lu.error.issues.slice(0, MAX_MESSAGES).map((i) => i.message);
    const refus = lu.data.requetes.flatMap((r) => verifierForme(r.forme, r.parametres, modele).refus.map((m) => `${r.nom} : ${m}`));
    return refus.slice(0, MAX_MESSAGES);
  } catch {
    return ["données déclarées illisibles"];
  }
}

// Le manifest.json rangé et signé est ce que relira l'exécuteur : la vérification porte sur ses octets, jamais sur la copie lue par zod (qui écarte __proto__ en silence).
// Refuse toute clé __proto__ PROPRE, à tout niveau, et constructor portant prototype ; profondeur bornée (échec fermé). Rend les messages de refus (vide = accepté).
const PROFONDEUR_MAX = 32;
function cleDangereuse(v: unknown, profondeur: number): string | undefined {
  if (profondeur > PROFONDEUR_MAX) return "manifeste trop profond";
  if (typeof v !== "object" || v === null) return undefined;
  if (!Array.isArray(v)) {
    if (Object.hasOwn(v, "__proto__")) return "clé __proto__ interdite";
    const c = (v as Record<string, unknown>)["constructor"];
    if (Object.hasOwn(v, "constructor") && typeof c === "object" && c !== null && Object.hasOwn(c, "prototype")) return "clé constructor.prototype interdite";
  }
  for (const x of Object.values(v)) {
    const r = cleDangereuse(x, profondeur + 1);
    if (r) return r;
  }
  return undefined;
}

export function verifierManifesteSigne(octets: Uint8Array, modele: Modele = MODELE_BASE_CLIENT): string[] {
  try {
    const brut: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(octets));
    const danger = cleDangereuse(brut, 0);
    if (danger) return [danger];
    if (typeof brut !== "object" || brut === null || Array.isArray(brut)) return ["manifeste illisible"];
    return verifierDonneesDeclarees(brut as Record<string, unknown>, modele);
  } catch {
    return ["manifeste illisible"];
  }
}
