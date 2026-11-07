// « Un exemple concret » du rapport (B-408). En V1 AUCUNE session système ne lit la base du client : l'adaptateur n'en rend aucun
// et la rubrique est omise (décision de l'architecte ; dette T5-22-dette-exemple). Ici : le port et la garde d'appartenance seulement.
export interface ExempleConcret { tenantId: string; titre: string; texte: string }
export interface ExempleRapport {
  // Doit lire dans la base DU client `tenantId`, avec la session du rapport de ce client.
  lire(tenantId: string): Promise<ExempleConcret | undefined>;
}
export class ExempleHorsClient extends Error {}

export const exempleOmis: ExempleRapport = { lire: async () => undefined };

const MAX_TITRE = 200;
const MAX_TEXTE = 500;
// eslint-disable-next-line no-control-regex
const CONTROLE = /[\u0000-\u001f\u007f-\u009f]/g;
export const nettoyerTexte = (s: string, max: number): string => Array.from(s.replace(CONTROLE, "")).slice(0, max).join("").trim();

// Un exemple d'un autre client fait échouer la préparation de CE rapport : pas de repli, rien n'est affiché.
export async function lireExempleDuClient(port: ExempleRapport, tenantId: string): Promise<{ titre: string; texte: string } | undefined> {
  const e = await port.lire(tenantId);
  if (e === undefined) return undefined;
  if (e.tenantId !== tenantId) throw new ExempleHorsClient("exemple_hors_client");
  return { titre: nettoyerTexte(e.titre, MAX_TITRE), texte: nettoyerTexte(e.texte, MAX_TEXTE) };
}
