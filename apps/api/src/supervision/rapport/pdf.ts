// Contenu du PDF du rapport mensuel (B-408, C-058) : composition PURE et typée, puis port `rendre`.
// Le rendu réel (gabarit de design, couleurs d'AXION IA) est une dette rattachée à LOT2b-dette-T2-46-adaptateurs.
// Aucun champ de prix, de coût, d'UIA, de marge, de métier ni de moyenne d'autres clients n'existe dans ces types.
import { calculerMesures, type EntreeInstance, type MesuresClient } from "./calculs.js";
import { lireExempleDuClient, nettoyerTexte, type ExempleRapport } from "./exemple.js";

export interface Candidate { code: string; libelle: string; etape10RapportMensuel: boolean; famillesCompatibles: string[] }
export interface Conseil { code: string; libelle: string }
export interface EntreeRapport {
  tenantId: string;
  raisonSociale: string;
  mois: string;
  instances: EntreeInstance[];
  candidates: Candidate[];
  famillesReliees: string[]; // familles des outils reliés à l'état actif
  codesActifs: string[]; // automatisations déjà actives chez le client
}
export interface ContenuRapport {
  tenantId: string;
  raisonSociale: string; // TEXTE, jamais HTML
  mois: string;
  mesures: MesuresClient;
  conseil?: Conseil;
  exemple?: { titre: string; texte: string };
  notes: string[];
}
export interface PortsPdf { exemple: ExempleRapport; rendre(c: ContenuRapport): Promise<Uint8Array> }
export class RapportRefuse extends Error {}

const MAX_RAISON_SOCIALE = 200;

// Règle écrite : étape 10 publiée avec le drapeau strictement vrai (C-250), outil relié compatible, pas déjà active ; tri par code ; une seule.
export function choisirConseil(e: Pick<EntreeRapport, "candidates" | "famillesReliees" | "codesActifs">): Conseil | undefined {
  const c = e.candidates
    .filter((x) => x.etape10RapportMensuel === true && !e.codesActifs.includes(x.code) && x.famillesCompatibles.some((f) => e.famillesReliees.includes(f)))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))[0];
  return c ? { code: c.code, libelle: c.libelle } : undefined;
}

export function composerContenu(e: EntreeRapport, mesures: MesuresClient, exemple: { titre: string; texte: string } | undefined): ContenuRapport {
  const raisonSociale = nettoyerTexte(e.raisonSociale, MAX_RAISON_SOCIALE);
  if (raisonSociale === "") throw new RapportRefuse("raison_sociale_vide");
  const conseil = choisirConseil(e);
  return {
    tenantId: e.tenantId, raisonSociale, mois: e.mois, mesures,
    ...(conseil ? { conseil } : {}),
    ...(exemple ? { exemple } : {}),
    notes: ["Cumul calculé sur la base du temps actuel par élément."],
  };
}

export async function preparerPdf(p: PortsPdf, e: EntreeRapport): Promise<{ contenu: ContenuRapport; octets: Uint8Array }> {
  const mesures = calculerMesures(e.tenantId, e.instances, e.mois);
  const exemple = await lireExempleDuClient(p.exemple, e.tenantId); // échoue avant tout rendu si l'exemple n'est pas du client
  const contenu = composerContenu(e, mesures, exemple);
  return { contenu, octets: await p.rendre(contenu) };
}
