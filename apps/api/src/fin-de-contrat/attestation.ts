import { createHash } from "node:crypto";
import { exigerAucunGel } from "../gel/garde.js";
import type { GelLitige } from "../retention/purger.js";
import { echeance, type Dossier, type EtapeFin } from "./machine.js";
import { composerContenu, OBJETS_GARDES, texteDe, type ContenuAttestation, type NatureAttestation, type ObjetCompteRendu, type PieceGardee } from "../pdf/attestation-contenu.js";

export { texteDe, type ContenuAttestation, type NatureAttestation };

// Attestations de fin de contrat (A-258, A-259, B-376, C-054, C-505, C-715). Ce fichier ne supprime rien et n'importe pas effacer.ts : il lit les comptes rendus
// de mettre-a-l-ecart.ts et d'effacer.ts (via les ports) et la raison sociale en console, jamais la base du client (refusée après la mise à l'écart).
// Aucune attestation à J+65 : la seule étape datée est J+30, après la mise à l'écart.
const TRENTE_JOURS_MS = 30 * 86_400_000;

export class AttestationRefusee extends Error {
  constructor(public readonly code: string) { super(code); this.name = "AttestationRefusee"; }
}

export interface FinDeContrat { identifiantConsole: string; raisonSociale: string; dateFin: string; exportDisponibleDepuis: Date | null; delaiPropositionMois: number }
export interface CompteRendu { objets: ObjetCompteRendu[]; signataire: string; confirmeLe: Date }
// Décision de Will enregistrée (T2-45) : demande écrite acceptée, ou proposition de suppression acceptée (avec la date de l'avis au client).
export interface DecisionEffacement { source: "demande" | "proposition"; decideLe: Date; avisClientLe: Date | null }
export interface Rangement { tenantId: string; finDeContratId: string; nature: NatureAttestation; octets: Uint8Array; empreinteSha256: string; titreContrat: string }
export interface MessageAttestation { tenantId: string; finDeContratId: string; nature: NatureAttestation; pdfReference: string; empreinteSha256: string; cle: string }

export interface PortsAttestation {
  gel: Pick<GelLitige, "gelActif">;
  maintenant(): Date;
  fin(tenantId: string, finDeContratId: string): Promise<FinDeContrat | undefined>;
  compteRendu(tenantId: string, finDeContratId: string, nature: NatureAttestation): Promise<CompteRendu | undefined>;
  decisionEffacement(tenantId: string, finDeContratId: string): Promise<DecisionEffacement | undefined>;
  piecesGardees(): Promise<PieceGardee[]>;
  rendre(c: ContenuAttestation): Promise<Uint8Array>;
  // Dépôt dans le compartiment commun « suivi », lignes `attestations_fin_de_contrat` (colonne nature) et `contrats` (type « autre »). Rejouable : « ignorer si existe ».
  ranger(r: Rangement): Promise<{ reference: string }>;
  // E-mail de SERVICE avec la pièce (EnvoisService) ; clé stable, le même dépôt rejoué ne part qu'une fois.
  envoyer(m: MessageAttestation): Promise<void>;
  tracer(e: Record<string, unknown>): Promise<void>;
}

export async function produireAttestation(p: PortsAttestation, tenantId: string, finDeContratId: string, nature: NatureAttestation): Promise<{ reference: string; empreinteSha256: string }> {
  // Un gel pour litige suspend aussi l'envoi (C-609) ; relu ici, juste avant de produire.
  await exigerAucunGel(p.gel, tenantId, "preavis");
  const fin = await p.fin(tenantId, finDeContratId);
  if (!fin) throw new AttestationRefusee("fin_de_contrat_inconnue");
  const maintenant = p.maintenant();
  let avisClientLe: Date | null = null;
  if (nature === "mise_a_l_ecart") {
    // B-376, C-505 : l'export doit être resté disponible 30 jours avant la mise à l'écart, donc avant son attestation.
    if (fin.exportDisponibleDepuis === null || maintenant.getTime() - fin.exportDisponibleDepuis.getTime() < TRENTE_JOURS_MS) throw new AttestationRefusee("export_moins_de_30_jours");
  } else {
    const decision = await p.decisionEffacement(tenantId, finDeContratId);
    if (!decision) throw new AttestationRefusee("decision_effacement_absente");
    if (decision.source === "proposition" && decision.avisClientLe === null) throw new AttestationRefusee("avis_client_absent");
    avisClientLe = decision.avisClientLe;
  }
  const compte = await p.compteRendu(tenantId, finDeContratId, nature);
  if (!compte) throw new AttestationRefusee(nature === "effacement" ? "effacement_non_execute" : "mise_a_l_ecart_non_faite");
  if (nature === "mise_a_l_ecart" && !OBJETS_GARDES.every((t) => compte.objets.some((o) => o.type === t))) throw new AttestationRefusee("compte_rendu_incomplet");
  const pieces = await p.piecesGardees();
  if (pieces.length === 0) throw new AttestationRefusee("pieces_gardees_absentes");
  const contenu = composerContenu({ nature, identifiantConsole: fin.identifiantConsole, raisonSociale: fin.raisonSociale, dateFin: fin.dateFin, delaiPropositionMois: fin.delaiPropositionMois, objets: compte.objets, pieces, signataire: compte.signataire, emisLe: maintenant, avisClientLe });
  const octets = await p.rendre(contenu);
  const empreinteSha256 = createHash("sha256").update(octets).digest("hex");
  const titreContrat = nature === "mise_a_l_ecart" ? "attestation de mise à l'écart" : "attestation d'effacement";
  const { reference } = await p.ranger({ tenantId, finDeContratId, nature, octets, empreinteSha256, titreContrat });
  await p.envoyer({ tenantId, finDeContratId, nature, pdfReference: reference, empreinteSha256, cle: `attestation:${tenantId}:${finDeContratId}:${nature}` });
  await p.tracer({ type: "attestation_emise", tenantId, finDeContratId, nature, empreinteSha256 });
  return { reference, empreinteSha256 };
}

export interface AideEtapeAttestation {
  finDeContratId(tenantId: string): string;
  dejaRangee(tenantId: string, nature: NatureAttestation): Promise<boolean>;
  miseALEcartFaite(tenantId: string): Promise<boolean>;
}
// Étape de la machine, APRÈS la mise à l'écart de J+30 : l'attestation de mise à l'écart n'est jamais émise avant elle, et il n'y en a pas d'autre à une autre date.
export function etapeAttestation(p: PortsAttestation, a: AideEtapeAttestation): EtapeFin {
  return {
    nom: "attestation_mise_a_l_ecart",
    sousGel: true,
    echeance: (d: Dossier) => echeance(d.dateFin, 30),
    dejaFait: (t) => a.dejaRangee(t, "mise_a_l_ecart"),
    async faire(t) {
      if (!(await a.miseALEcartFaite(t))) return;
      await produireAttestation(p, t, a.finDeContratId(t), "mise_a_l_ecart");
    },
  };
}
