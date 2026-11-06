import { ErreurApi } from "../plugins/erreurs.js";
import type { AlerteFin } from "./machine.js";
import { recevoirDemandeEffacement } from "./machine.js";
import { exigerAucunGel } from "../gel/garde.js";
import type { GelLitige } from "../retention/purger.js";
import { exigerSession, idTacheEffacement, validationDe, validerEtDeclencher, type SessionDecision, type TxAcceptation } from "./decision-proposition.js";

// Demande écrite du client (RGPD art. 28.3.g et 17, C-623, C-715). Enregistrer la demande ne supprime rien et ne change aucune date.
export type DecisionEffacement =
  | { action: "accepter" }
  | { action: "refuser"; cause: "litige_en_cours" | "obligation_legale"; motif: string; gelId?: string; referenceTexte?: string };
export interface TxDemande extends TxAcceptation {
  poserRefusee(r: { cause: string; gelId: string | null; referenceTexte: string | null; motif: string; par: string; le: Date }): Promise<boolean>;
}
export interface PortsDemande {
  gel: Pick<GelLitige, "gelActif">;
  gelActifId(tenantId: string, gelId: string): Promise<boolean>;
  maintenant(): Date;
  alerter(a: AlerteFin): Promise<void>;
  creer(tenantId: string, ecritReference: string): Promise<{ id: string }>;
  // Filtrée par client.
  demande(tenantId: string, id: string): Promise<{ id: string; tenantId: string; etat: string } | undefined>;
  // Le motif écrit est communiqué au client.
  informerClient(tenantId: string, motif: string): Promise<void>;
  transaction<T>(id: string, fn: (tx: TxDemande) => Promise<T>): Promise<T>;
}

export const enregistrerDemandeEffacement = (p: Pick<PortsDemande, "creer" | "alerter">, tenantId: string, refEcrit: string) => recevoirDemandeEffacement(p, tenantId, refEcrit);

export async function deciderEffacement(p: PortsDemande, tenantId: string, demandeId: string, decision: DecisionEffacement, s: SessionDecision): Promise<"acceptee" | "validation_enregistree" | "refusee"> {
  const maintenant = p.maintenant();
  exigerSession(s, maintenant, decision.action === "accepter" ? ["will", "second_administrateur"] : ["will"]);
  const regle = (m: string) => new ErreurApi("regle_metier", m);
  if (decision.action === "refuser") {
    if (typeof decision.motif !== "string" || decision.motif.trim() === "") throw new ErreurApi("schema_invalide", "Requête invalide.");
    // Le refus n'a que deux causes : litige en cours (gel ACTIF de ce client) ou obligation légale (texte cité).
    if (decision.cause === "litige_en_cours") { if (!(decision.gelId && (await p.gelActifId(tenantId, decision.gelId)))) throw regle("Aucun gel actif pour ce litige."); }
    else if (decision.cause === "obligation_legale") { if ((decision.referenceTexte ?? "").trim() === "") throw regle("La référence du texte est obligatoire."); }
    else throw regle("Une demande écrite du client ne se refuse que pour un litige ou une obligation légale.");
  }
  const d = await p.demande(tenantId, demandeId);
  if (!d) throw new ErreurApi("introuvable", "Ressource introuvable.");
  if (d.etat !== "en_attente") throw regle("La demande n'est plus en attente.");
  if (decision.action === "refuser") {
    const motif = decision.motif.trim();
    const ok = await p.transaction(demandeId, (tx) => tx.poserRefusee({ cause: decision.cause, gelId: decision.gelId ?? null, referenceTexte: decision.referenceTexte?.trim() || null, motif, par: s.acteur, le: maintenant }));
    if (!ok) throw regle("La demande n'est plus en attente.");
    await p.informerClient(tenantId, motif);
    return "refusee";
  }
  await exigerAucunGel(p.gel, tenantId, "effacement");
  return p.transaction(demandeId, (tx) => validerEtDeclencher(tx, tenantId, validationDe(tenantId, s, maintenant), idTacheEffacement("demande", demandeId), { genre: "demande", id: demandeId }));
}
