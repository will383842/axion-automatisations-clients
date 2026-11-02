import { ErreurCourtier, type Journal } from "./identifiants-base.js";

// Accès humain exceptionnel (A-211) : identifiant dynamique d'OpenBao (moteur database/), lecture seule, une heure au plus, ouvert seulement avec une intervention valide
// de visibilite_acces (T2-30) : période en cours ET accord écrit du client. Le jeton de ce chemin n'est pas celui de l'exécuteur.
export const DUREE_MAX_S = 3600;
export interface Intervention { perimetre: string; debut: Date; fin: Date; accords: string[] }
export interface PortsAccesHumain {
  intervention(tenantId: string): Promise<Intervention | undefined>;
  creds: { emettre(): Promise<{ utilisateur: string; motDePasse: string; dureeSecondes: number }> };
  journal: Journal;
  maintenant(): Date;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function ouvrirAccesHumain(p: PortsAccesHumain, tenantBrut: string, qui: string, motif: string): Promise<{ utilisateur: string; motDePasse: string; expire: Date; lectureSeule: true }> {
  const tenantId = typeof tenantBrut === "string" ? tenantBrut.toLowerCase() : "";
  const q = typeof qui === "string" ? qui.trim() : "";
  const m = typeof motif === "string" ? motif.trim() : "";
  if (!UUID.test(tenantId) || q === "" || q.length > 200 || m === "" || m.length > 500) throw new ErreurCourtier("demande_invalide");
  const maintenant = p.maintenant();
  const i = await p.intervention(tenantId);
  if (!i || i.accords.length === 0 || i.debut.getTime() > maintenant.getTime() || i.fin.getTime() <= maintenant.getTime()) {
    p.journal.tracer({ evenement: "acces_humain_refuse", tenantId, qui: q, motif: m, code: "accord_absent" });
    throw new ErreurCourtier("accord_absent");
  }
  const c = await p.creds.emettre();
  if (!Number.isFinite(c.dureeSecondes) || c.dureeSecondes < 1) throw new ErreurCourtier("coffre_indisponible");
  if (c.dureeSecondes > DUREE_MAX_S) throw new ErreurCourtier("duree_excessive");
  // Le bail s'éteint seul ; l'échéance annoncée ne dépasse jamais la fin de l'intervention.
  const expire = new Date(Math.min(maintenant.getTime() + c.dureeSecondes * 1000, i.fin.getTime()));
  p.journal.tracer({ evenement: "acces_humain_ouvert", tenantId, qui: q, motif: m, expire: expire.toISOString() });
  return { utilisateur: c.utilisateur, motDePasse: c.motDePasse, expire, lectureSeule: true };
}

// OpenBao : un seul chemin, le rôle dynamique en lecture seule. Le corps d'une réponse en erreur n'est jamais repris.
export function credsHumainOpenBao(o: { url: string; jeton: string; fetch?: typeof fetch }): PortsAccesHumain["creds"] {
  return {
    async emettre() {
      const r = await (o.fetch ?? fetch)(`${o.url}/v1/database/creds/humain-lecture-cli`, { headers: { "X-Vault-Token": o.jeton }, redirect: "error", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      if (!r?.ok) throw new ErreurCourtier("coffre_indisponible");
      const c = (await r.json().catch(() => ({}))) as { lease_duration?: unknown; data?: { username?: unknown; password?: unknown } };
      const { username, password } = c.data ?? {};
      if (typeof username !== "string" || typeof password !== "string" || typeof c.lease_duration !== "number") throw new ErreurCourtier("coffre_indisponible");
      return { utilisateur: username, motDePasse: password, dureeSecondes: c.lease_duration };
    },
  };
}
