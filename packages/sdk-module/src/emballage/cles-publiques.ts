// Liste ÉPINGLÉE des clés de publication : aucune lecture de réglage ni de variable d'environnement.
// Vide en production tant que le coffre (T4-26) n'a pas fourni la clé ; les tests injectent leur clé de test.
export type ClePublique = { readonly idCle: string; readonly publique: string; readonly revoquee?: boolean };

export const CLES_PUBLIQUES: readonly ClePublique[] = [];
