import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { MOTIFS_EQUIPE, type MotifEquipe } from "../export/exporter.js";
import { ErreurApi } from "../plugins/erreurs.js";

// Export complet du client (A-252, B-371, C-536). Trois routes :
//   - portail (client) : GET lit l'état et crée un lien signé de 15 minutes au plus ; POST demande un export. Le client vient de la SESSION, jamais de l'URL, d'un en-tête, d'un cookie ou du corps ;
//   - console (équipe) : POST, réauthentification, motif fermé (fin de contrat ou demande écrite du client), tracé.
// Les gestionnaires sont exportés SANS enregistrement (comme donnees-quotas.ts) : l'inscription dans scripts/liste-routes.ts et apps/api/src/serveur.ts n'est pas dans les fichiers de la fiche.
export const CHEMIN_PORTAIL = "/api/portail/v1/export";
export const CHEMIN_CONSOLE = "/api/console/v1/clients/:id/export";

export interface ServiceExport {
  demander(d: { tenantId: string; acteur: string }): Promise<{ demande: string }>;
  demanderParEquipe(d: { tenantId: string; acteur: string; motif: MotifEquipe }): Promise<{ demande: string }>;
  lien(d: { tenantId: string; demande?: string; acteur: string }): Promise<{ demande: string; expireLe: Date; lien: string; lienExpireLe: Date }>;
}
export interface DepsExport {
  service: ServiceExport;
  exigerEquipe: preHandlerAsyncHookHandler;
  exigerReauth: preHandlerAsyncHookHandler;
  session(requete: FastifyRequest): Promise<{ tenantId: string }>;
  acteurEquipe(requete: FastifyRequest): string;
}

const Requete = z.object({ demande: z.uuid().optional() });
const Params = z.strictObject({ id: z.uuid() });
const Corps = z.strictObject({ motif: z.enum(MOTIFS_EQUIPE) });
const invalide = () => new ErreurApi("schema_invalide", "Requête invalide.");
// Un export d'un autre client, absent ou retiré : même réponse. Seul l'export échu a son propre refus.
const traduire = (e: unknown): never => {
  const m = e instanceof Error ? e.message : "";
  if (m === "introuvable") throw new ErreurApi("introuvable", "Ressource introuvable.");
  if (m === "export_expire") throw new ErreurApi("regle_metier", "Cet export n'est plus disponible : demandez-en un nouveau.");
  throw e;
};

export function gestionnairesExport(d: DepsExport) {
  return {
    exigerEquipe: d.exigerEquipe,
    exigerReauth: d.exigerReauth,
    lire: async (requete: FastifyRequest) => {
      const q = Requete.safeParse(requete.query ?? {});
      if (!q.success) throw invalide();
      const { tenantId } = await d.session(requete);
      const r = await d.service.lien({ tenantId, acteur: "client", ...(q.data.demande ? { demande: q.data.demande } : {}) }).catch(traduire);
      return { demande: r.demande, expire_le: r.expireLe.toISOString(), lien: r.lien, lien_expire_le: r.lienExpireLe.toISOString() };
    },
    demander: async (requete: FastifyRequest, reponse: { status(n: number): unknown }) => {
      const { tenantId } = await d.session(requete);
      const r = await d.service.demander({ tenantId, acteur: "client" });
      reponse.status(202);
      return r;
    },
    demanderParEquipe: async (requete: FastifyRequest, reponse: { status(n: number): unknown }) => {
      const p = Params.safeParse(requete.params);
      const c = Corps.safeParse(requete.body);
      if (!p.success || !c.success) throw invalide();
      const r = await d.service.demanderParEquipe({ tenantId: p.data.id, acteur: d.acteurEquipe(requete), motif: c.data.motif }).catch(traduire);
      reponse.status(202);
      return r;
    },
  };
}
