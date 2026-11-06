import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { ErreurApi } from "../plugins/erreurs.js";
import { ajouterJours, type JourPreavis } from "../fin-de-contrat/machine.js";

// Fin de contrat (C-035, A-253, A-255). Les gestionnaires sont exportés SANS enregistrement (comme export.ts) : l'inscription dans scripts/liste-routes.ts et serveur.ts n'est pas dans les fichiers de la fiche.
// Le client vient de la SESSION de l'équipe ; celui de l'URL doit lui être égal. Le client lance une fin de contrat pour lui-même seulement via l'équipe : aucune route portail ne la lance.
export const CHEMIN_CONSOLE = "/api/console/v1/clients/:id/fin-de-contrat";
export const CHEMIN_EFFACEMENT = "/api/console/v1/clients/:id/demande-effacement";
export const CHEMIN_ACCUSE = "/api/portail/v1/fin-de-contrat/accuse/:tenantId/:jour/:jeton";

export interface SessionFin { acteur: string; role: string; clientActifId: string; reauthentifie: boolean }
export interface DepsFin {
  session(requete: FastifyRequest): Promise<SessionFin>;
  // Crée la ligne fins_de_contrat et planifie les tâches (planifierTaches) ; rien d'autre.
  lancer(d: { tenantId: string; dateFin: string; acteur: string }): Promise<void>;
  demanderEffacement(tenantId: string, ecritReference: string): Promise<void>;
  confirmer(tenantId: string, jour: JourPreavis, jeton: string): Promise<boolean>;
}
const Params = z.strictObject({ id: z.uuid() });
const CorpsLancer = z.strictObject({ dateFin: z.string().refine((v) => { try { ajouterJours(v, 0); return true; } catch { return false; } }) });
const CorpsEffacement = z.strictObject({ ecritReference: z.string().trim().min(1).max(500) });
const ParamsAccuse = z.strictObject({ tenantId: z.uuid(), jour: z.enum(["1", "20", "27"]), jeton: z.string().min(1).max(200) });
const invalide = () => new ErreurApi("schema_invalide", "Requête invalide.");

// Administrateur, réauthentifié, acteur identifié, et le client de l'URL est le client actif de la session (attaque 5).
function exigerDroit(s: SessionFin, tenantId: string): string {
  if (s.role !== "administrateur") throw new ErreurApi("action_interdite", "Action réservée à l'administrateur.");
  if (!s.reauthentifie) throw new ErreurApi("reauthentification_requise", "Reconnectez-vous pour continuer.");
  if (s.clientActifId !== tenantId) throw new ErreurApi("action_interdite", "Client différent de la session.");
  const acteur = s.acteur.trim();
  if (acteur === "" || acteur.toLowerCase() === "systeme") throw new ErreurApi("action_interdite", "Acteur identifié requis.");
  return acteur;
}

export function gestionnairesFinDeContrat(d: DepsFin) {
  return {
    lancer: async (requete: FastifyRequest, reponse: { status(n: number): unknown }) => {
      const p = Params.safeParse(requete.params);
      if (!p.success) throw invalide();
      const acteur = exigerDroit(await d.session(requete), p.data.id);
      const c = CorpsLancer.safeParse(requete.body);
      if (!c.success) throw invalide();
      await d.lancer({ tenantId: p.data.id, dateFin: c.data.dateFin, acteur });
      reponse.status(202);
      return { etat: "lancee" };
    },
    demandeEffacement: async (requete: FastifyRequest, reponse: { status(n: number): unknown }) => {
      const p = Params.safeParse(requete.params);
      if (!p.success) throw invalide();
      exigerDroit(await d.session(requete), p.data.id);
      const c = CorpsEffacement.safeParse(requete.body);
      if (!c.success) throw invalide();
      await d.demanderEffacement(p.data.id, c.data.ecritReference);
      reponse.status(202);
      return { etat: "en_attente" };
    },
    // Lien du courriel : le jeton lie le client et le jour ; jeton faux, jour inconnu ou préavis non envoyé répondent pareil.
    accuse: async (requete: FastifyRequest) => {
      const p = ParamsAccuse.safeParse(requete.params);
      const ok = p.success && (await d.confirmer(p.data.tenantId, Number(p.data.jour) as JourPreavis, p.data.jeton));
      if (!ok) throw new ErreurApi("introuvable", "Ressource introuvable.");
      return { etat: "confirme" };
    },
  };
}
