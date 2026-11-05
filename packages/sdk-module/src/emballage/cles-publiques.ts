// Listes ÉPINGLÉES des clés de publication : aucune lecture de réglage ni de variable d'environnement.
// Elles sont renseignées au déploiement avec les clés PUBLIQUES du coffre (T4-26/T4-27), jamais avec une clé privée.
// idCle = « <clé du coffre>:v<version> » ; retirer une entrée (ou la marquer révoquée) révoque la version.
export type ClePublique = { readonly idCle: string; readonly publique: string; readonly revoquee?: boolean };
export type Environnement = "production" | "recette";
export type ListesEpinglees = { readonly publication: readonly ClePublique[]; readonly recette: readonly ClePublique[] };

// Vides tant que le coffre n'a pas fourni les clés : alors rien ne se charge.
export const CLES_PUBLICATION: readonly ClePublique[] = [];
export const CLES_RECETTE: readonly ClePublique[] = [];
export const EPINGLEES: ListesEpinglees = { publication: CLES_PUBLICATION, recette: CLES_RECETTE };
// Liste par défaut des consommateurs : celle de la production (la plus stricte).
export const CLES_PUBLIQUES: readonly ClePublique[] = CLES_PUBLICATION;

const FORME = { publication: /^modules-publication:v[1-9]\d{0,5}$/, recette: /^modules-recette:v[1-9]\d{0,5}$/ };

// La production n'accepte QUE modules-publication ; la recette accepte les deux. Un environnement inconnu, ou une clé rangée
// dans la mauvaise liste, fait échouer : jamais de liste permissive par défaut.
export function clesAcceptees(environnement: unknown, listes: ListesEpinglees = EPINGLEES): readonly ClePublique[] {
  if (environnement !== "production" && environnement !== "recette") throw new Error("environnement inconnu");
  if (!listes.publication.every((c) => FORME.publication.test(c.idCle)) || !listes.recette.every((c) => FORME.recette.test(c.idCle))) throw new Error("clé épinglée dans la mauvaise liste");
  return environnement === "production" ? [...listes.publication] : [...listes.publication, ...listes.recette];
}
