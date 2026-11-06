import { ErreurApi } from "../plugins/erreurs.js";
import type { GelLitige } from "../retention/purger.js";
import { echeance, type AlerteFin } from "./machine.js";

// SEUL contenu de la tâche planifiée de la fin de vie des données (C-715) : elle écrit UNE ligne de proposition à l'état en_attente, avise le client et alerte Will.
// Elle ne supprime rien et n'importe ni effacer.ts ni decision-proposition.ts (garde scripts/garde-effacement.ts).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const DELAI_MINIMAL_MOIS = 2;

export interface FinRef { id: string; tenantId: string; dateFin: string }
export interface PortsProposition {
  // Dernière surcharge du client, sinon dernière ligne du réglage global : lu en base, jamais écrit ici.
  delaiMois(tenantId: string): Promise<number>;
  // INSERT … ON CONFLICT (tenant_id, fin_de_contrat_id, echeance) DO NOTHING : l'unicité est celle de la base.
  inserer(n: { tenantId: string; finDeContratId: string; echeance: string }): Promise<{ id: string; cree: boolean; avisEnvoyeLe: Date | null }>;
  envoyerAvis(tenantId: string, propositionId: string): Promise<void>;
  marquerAvis(propositionId: string, quand: Date): Promise<void>;
  enAttente(): Promise<{ id: string; tenantId: string; avisEnvoyeLe: Date | null }[]>;
  gel: Pick<GelLitige, "gelActif">;
  alerter(a: AlerteFin): Promise<void>;
  maintenant(): Date;
}

// jobId valide pour BullMQ (pas de « : ») et propre à la fin de contrat ET à l'échéance : un renouvellement ou une seconde fin du même client n'est pas avalé.
export function idTachePropositionSuppression(finDeContratId: string, echeanceJour: string): string {
  if (!UUID.test(finDeContratId) || !DATE.test(echeanceJour)) throw new Error("identifiant invalide");
  return `proposition-${finDeContratId}-${echeanceJour}`;
}
// Mois calendaires ; le jour est ramené à la fin du mois si besoin (31 janvier + 1 mois = 28 février).
export function ajouterMois(jour: string, mois: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(jour);
  if (!m) throw new Error("date invalide");
  const total = Number(m[1]) * 12 + Number(m[2]) - 1 + mois;
  const a = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  const dernier = new Date(Date.UTC(a, mo, 0)).getUTCDate();
  return `${String(a).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(Math.min(Number(m[3]), dernier)).padStart(2, "0")}`;
}
const jourDe = (t: Date) => t.toISOString().slice(0, 10);

// Gel pour litige : l'avis au client est un envoi, il attend la levée (C-609) ; la proposition, elle, existe et Will est alerté.
async function aviser(p: PortsProposition, tenantId: string, id: string): Promise<void> {
  if (await p.gel.gelActif(tenantId)) return;
  await p.envoyerAvis(tenantId, id);
  await p.marquerAvis(id, p.maintenant());
}

export async function creerPropositionSuppression(p: PortsProposition, fin: FinRef, echeanceImposee?: string): Promise<"creee" | "existante" | "pas_encore"> {
  // Une échéance imposée (renouvellement après un écart) ne passe jamais sous le plancher de 2 mois après la fin.
  if (echeanceImposee !== undefined && (!DATE.test(echeanceImposee) || echeanceImposee < ajouterMois(fin.dateFin, DELAI_MINIMAL_MOIS))) throw new ErreurApi("regle_metier", "Échéance de proposition invalide.");
  const jour = echeanceImposee ?? (await (async () => {
    const delai = await p.delaiMois(fin.tenantId);
    if (!Number.isInteger(delai) || delai < DELAI_MINIMAL_MOIS) throw new ErreurApi("regle_metier", "Délai de proposition invalide.");
    return ajouterMois(fin.dateFin, delai);
  })());
  if (!DATE.test(jour) || p.maintenant() < echeance(jour, 0)) return "pas_encore";
  const ligne = await p.inserer({ tenantId: fin.tenantId, finDeContratId: fin.id, echeance: jour });
  if (ligne.avisEnvoyeLe === null) await aviser(p, fin.tenantId, ligne.id);
  if (ligne.cree) await p.alerter({ type: "proposition_suppression", clientId: fin.tenantId, code: `proposition_en_attente_${jourDe(p.maintenant())}` });
  return ligne.cree ? "creee" : "existante";
}

// Tâche quotidienne : tant qu'une proposition est en attente, Will est alerté chaque jour ; un avis resté en attente (gel) est envoyé dès que le gel est levé.
export async function rappelerPropositions(p: PortsProposition): Promise<void> {
  for (const x of await p.enAttente()) {
    if (x.avisEnvoyeLe === null) await aviser(p, x.tenantId, x.id);
    await p.alerter({ type: "proposition_suppression", clientId: x.tenantId, code: `proposition_en_attente_${jourDe(p.maintenant())}` });
  }
}
