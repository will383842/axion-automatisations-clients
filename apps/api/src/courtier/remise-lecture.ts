import { identifiantsLecturePourTache, ErreurCourtier, type PortsIdentifiants } from "./identifiants-base.js";

// Route de remise de la base en lecture (ADR 0113) : type FIXE base_lecture. La requête ne porte que tenantId et idTache ;
// ni genre, ni rôle, ni type n'y sont lus (champ en trop = demande_invalide). Le nom du rôle n'est jamais transmis : l'exécuteur le déduit de la base.
export interface RemiseBaseLecture { type: "base_lecture"; hote: string; base: string; motDePasse: string; expire: string; valideJusqua: string | null }

export async function remettreBaseLecture(p: PortsIdentifiants, brut: unknown): Promise<RemiseBaseLecture> {
  if (typeof brut !== "object" || brut === null || Array.isArray(brut) || Object.keys(brut).sort().join() !== "idTache,tenantId") throw new ErreurCourtier("demande_invalide");
  const { tenantId, idTache } = brut as Record<string, unknown>;
  if (typeof tenantId !== "string" || typeof idTache !== "string") throw new ErreurCourtier("demande_invalide");
  const r = await identifiantsLecturePourTache(p, tenantId, idTache);
  return { type: "base_lecture", hote: r.hote, base: r.base, motDePasse: r.motDePasse, expire: r.expire.toISOString(), valideJusqua: r.valideJusqua?.toISOString() ?? null };
}
