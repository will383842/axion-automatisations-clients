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
