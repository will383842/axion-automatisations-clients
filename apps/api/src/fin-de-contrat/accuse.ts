import { timingSafeEqual } from "node:crypto";
import { exigerAucunGel } from "../gel/garde.js";
import type { GelLitige } from "../retention/purger.js";
import type { JourPreavis } from "./machine.js";

// Envoi du préavis et accusé de réception (A-255). Le lien de confirmation est SANS état : jeton = signature de « accuse:<client>:<jour> » par la clé de la console,
// donc propre à un client et à un jour ; le cliquer deux fois n'enregistre qu'un accusé. La trace ne porte ni texte ni adresse.
// Les modèles de texte viennent du dépôt privé (T2-00) par la configuration de production ; le port d'envoi réel est la dette de branchement (voir la PR).
export interface MessagePreavis { type: `preavis_j${JourPreavis}`; clientId: string; cle: string; categorie: "service"; lien: string }
export interface EnvoiPreavis { deposerPreavis(m: MessagePreavis): Promise<void> }
export type Signer = (texte: string) => string;
type Tracer = (e: Record<string, unknown>) => Promise<void>;

export const lienAccuse = (signer: Signer, baseLien: string, tenantId: string, jour: JourPreavis): string => `${baseLien}/${tenantId}/${jour}/${signer(`accuse:${tenantId}:${jour}`)}`;

export function envoyerPreavis(o: { envois: EnvoiPreavis; gel: Pick<GelLitige, "gelActif">; signer: Signer; baseLien: string; tracer: Tracer }) {
  return async (tenantId: string, jour: JourPreavis, dateFin: string): Promise<void> => {
    // Relu juste avant le dépôt : un gel posé entre-temps l'emporte.
    await exigerAucunGel(o.gel, tenantId, "preavis");
    // Clé anti-doublon par client, jour et date de fin : le même dépôt rejoué ne crée rien de plus.
    await o.envois.deposerPreavis({ type: `preavis_j${jour}`, clientId: tenantId, cle: `preavis_j${jour}:${tenantId}:${dateFin}`, categorie: "service", lien: lienAccuse(o.signer, o.baseLien, tenantId, jour) });
    await o.tracer({ type: "preavis_depose", tenantId, jour });
  };
}

export function confirmerAccuse(o: { signer: Signer; enregistrer(tenantId: string, jour: JourPreavis, preuve: string): Promise<boolean>; tracer: Tracer; maintenant(): Date }) {
  return async (tenantId: string, jour: JourPreavis, jeton: string): Promise<boolean> => {
    const attendu = Buffer.from(o.signer(`accuse:${tenantId}:${jour}`));
    const recu = Buffer.from(typeof jeton === "string" ? jeton : "");
    if (attendu.length !== recu.length || !timingSafeEqual(attendu, recu)) return false;
    // L'adaptateur n'écrit que si le préavis est envoyé et sans accusé encore (UPDATE … WHERE preavis_jN_envoye_le IS NOT NULL AND preavis_jN_accuse IS NULL).
    const premier = await o.enregistrer(tenantId, jour, `recu:${o.maintenant().toISOString()}`);
    if (premier) await o.tracer({ type: "accuse_recu", tenantId, jour });
    return premier;
  };
}
