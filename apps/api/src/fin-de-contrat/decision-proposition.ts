import { ErreurApi } from "../plugins/erreurs.js";
import { retirerSousGel, exigerAucunGel } from "../gel/garde.js";
import type { GelLitige } from "../retention/purger.js";
import type { AlerteFin } from "./machine.js";
import { doubleValidationAtteinte, reauthentificationFraiche, type Validation } from "./mettre-a-l-ecart.js";
import { ajouterMois } from "./proposition-suppression.js";

// Le clic de Will (C-715) : SEUL module qui met en file un effacement à partir d'une proposition. Rien n'est supprimé ici : l'événement est traité par effacer.ts,
// qui relit l'état « acceptee » en base avant d'agir.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type EtatProposition = "en_attente" | "acceptee" | "ecartee" | "reexamen" | "executee";
const TRANSITIONS: Record<EtatProposition, readonly EtatProposition[]> = { en_attente: ["acceptee", "ecartee"], ecartee: ["reexamen"], acceptee: ["executee"], reexamen: [], executee: [] };
export const transitionPermise = (de: EtatProposition, vers: EtatProposition): boolean => TRANSITIONS[de].includes(vers);
export const AVIS_MINIMAL_MS = 30 * 24 * 3_600_000;
export const CAUSES_ECART = ["litige_en_cours", "obligation_legale", "decision_de_will"] as const;
export type CauseEcart = (typeof CAUSES_ECART)[number];

export interface Proposition { id: string; tenantId: string; finDeContratId: string; echeance: string; etat: EtatProposition; avisEnvoyeLe: Date | null; gelId: string | null }
export interface SessionDecision { acteur: string; role: string; reauthLe: Date | null; jetonId: string }

// jobId BullMQ valide (pas de « : »). Un job d'effacement n'est mis en file que par un clic de Will tracé, jamais par l'ordonnanceur ni par la levée d'un gel.
export function idTacheEffacement(genre: "proposition" | "demande", id: string): string {
  if (!UUID.test(id)) throw new Error("identifiant invalide");
  return genre === "demande" ? `effacement-demande-${id}` : `effacement-${id}`;
}

export interface TxAcceptation {
  gelActif(tenantId: string): Promise<boolean>;
  // false si le jeton de réauthentification a déjà servi (rejeu).
  ajouterValidation(v: Validation): Promise<boolean>;
  validations(): Promise<Validation[]>;
  // Compare-et-pose en_attente → acceptee.
  poserAcceptee(): Promise<boolean>;
  mettreEnFile(jobId: string, charge: Record<string, unknown>): Promise<void>;
}
export interface TxDecision extends TxAcceptation {
  poser(vers: EtatProposition, extra?: { gelId?: string; cause?: string; motif?: string }): Promise<boolean>;
  planifierProposition(finDeContratId: string, echeance: string): Promise<void>;
  creerProposition(finDeContratId: string, echeance: string): Promise<void>;
}
export interface PortsDecision {
  gel: Pick<GelLitige, "gelActif">;
  // Vrai si ce gel appartient à CE client et n'est pas levé.
  gelActifId(tenantId: string, gelId: string): Promise<boolean>;
  maintenant(): Date;
  // Filtrée par client : la proposition d'un autre client est « introuvable ».
  proposition(tenantId: string, id: string): Promise<Proposition | undefined>;
  propositionsParGel(tenantId: string, gelId: string): Promise<Proposition[]>;
  demandesParGel(tenantId: string, gelId: string): Promise<{ id: string }[]>;
  reouvrirDemande?(tenantId: string, id: string): Promise<void>;
  alerter(a: AlerteFin): Promise<void>;
  transaction<T>(id: string, fn: (tx: TxDecision) => Promise<T>): Promise<T>;
}

export function exigerSession(s: SessionDecision, maintenant: Date, roles: readonly string[]): Validation["role"] {
  if (!roles.includes(s.role) || s.acteur.trim() === "" || s.acteur.toLowerCase() === "systeme") throw new ErreurApi("action_interdite", "Action réservée à Will ou au second administrateur.");
  if (!reauthentificationFraiche(s.reauthLe, maintenant) || s.jetonId.trim() === "") throw new ErreurApi("reauthentification_requise", "Reconnectez-vous pour continuer.");
  return s.role;
}
export const validationDe = (tenantId: string, s: SessionDecision, maintenant: Date): Validation => ({ tenantId, acteur: s.acteur, role: s.role, a: maintenant, reauthLe: s.reauthLe, jetonId: s.jetonId });
const regle = (m: string) => new ErreurApi("regle_metier", m);
const introuvable = () => new ErreurApi("introuvable", "Ressource introuvable.");

// Enregistre une validation ; à la dernière, pose « acceptee » ET met l'événement en file dans la MÊME transaction, avec le gel relu dans cette transaction.
export async function validerEtDeclencher(tx: TxAcceptation, tenantId: string, v: Validation, jobId: string, charge: Record<string, unknown>): Promise<"acceptee" | "validation_enregistree"> {
  if (!(await tx.ajouterValidation(v))) throw regle("Cette réauthentification a déjà servi.");
  if (!doubleValidationAtteinte(tenantId, await tx.validations())) return "validation_enregistree";
  await retirerSousGel(tx, (t, id) => t.gelActif(id), tenantId, "effacement", async () => {
    if (!(await tx.poserAcceptee())) throw regle("La proposition n'est plus en attente.");
    await tx.mettreEnFile(jobId, charge);
  });
  return "acceptee";
}

export async function accepterProposition(p: PortsDecision, tenantId: string, propositionId: string, s: SessionDecision): Promise<"acceptee" | "validation_enregistree"> {
  const maintenant = p.maintenant();
  exigerSession(s, maintenant, ["will", "second_administrateur"]);
  // Le contrôle « la proposition appartient au client de l'URL » vient avant toute écriture.
  const prop = await p.proposition(tenantId, propositionId);
  if (!prop) throw introuvable();
  if (prop.etat !== "en_attente") throw regle("La proposition n'est plus en attente.");
  if (prop.avisEnvoyeLe === null || maintenant.getTime() - prop.avisEnvoyeLe.getTime() < AVIS_MINIMAL_MS) throw regle("L'avis au client date de moins de 30 jours.");
  await exigerAucunGel(p.gel, tenantId, "effacement");
  return p.transaction(propositionId, (tx) => validerEtDeclencher(tx, tenantId, validationDe(tenantId, s, maintenant), idTacheEffacement("proposition", propositionId), { genre: "proposition", id: propositionId }));
}

export async function ecarterProposition(p: PortsDecision, tenantId: string, propositionId: string, e: { cause: CauseEcart; motif: string; gelId?: string; referenceTexte?: string }, s: SessionDecision): Promise<void> {
  const maintenant = p.maintenant();
  exigerSession(s, maintenant, ["will"]);
  if (!CAUSES_ECART.includes(e.cause) || typeof e.motif !== "string" || e.motif.trim() === "") throw new ErreurApi("schema_invalide", "Requête invalide.");
  const prop = await p.proposition(tenantId, propositionId);
  if (!prop) throw introuvable();
  if (e.cause === "litige_en_cours" && !(e.gelId && (await p.gelActifId(tenantId, e.gelId)))) throw regle("Aucun gel actif pour ce litige.");
  if (e.cause === "obligation_legale" && (e.referenceTexte ?? "").trim() === "") throw regle("La référence du texte est obligatoire.");
  const aujourdhui = maintenant.toISOString().slice(0, 10);
  const suivante = ajouterMois(prop.echeance, 12);
  await p.transaction(propositionId, async (tx) => {
    if (!(await tx.poser("ecartee", { ...(e.cause === "litige_en_cours" && e.gelId ? { gelId: e.gelId } : {}), cause: e.cause, motif: e.motif.trim() }))) throw regle("La proposition n'est plus en attente.");
    await tx.planifierProposition(prop.finDeContratId, suivante > aujourdhui ? suivante : ajouterMois(aujourdhui, 12));
  });
}

// Gel levé : réexamen de ce qui avait été écarté ou refusé POUR CE GEL, jamais pour un autre. Ne supprime rien et ne met aucun effacement en file.
export async function reexaminerApresLevee(p: PortsDecision, tenantId: string, gelId: string): Promise<void> {
  const aujourdhui = p.maintenant().toISOString().slice(0, 10);
  for (const prop of await p.propositionsParGel(tenantId, gelId)) {
    await p.transaction(prop.id, async (tx) => {
      if (await tx.poser("reexamen")) await tx.creerProposition(prop.finDeContratId, aujourdhui);
    });
    await p.alerter({ type: "proposition_suppression", clientId: tenantId, code: `reexamen_${prop.id}` });
  }
  for (const d of await p.demandesParGel(tenantId, gelId)) {
    await p.reouvrirDemande?.(tenantId, d.id);
    await p.alerter({ type: "demande_effacement", clientId: tenantId, code: `reexamen_${d.id}` });
  }
}
