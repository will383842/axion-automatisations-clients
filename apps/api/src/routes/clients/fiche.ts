import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { ErreurApi } from "../../plugins/erreurs.js";

// Fiche client 360° (T3-13) : lecture seule, réservée à l'équipe. Le client de l'URL doit être dans la portée de la session, sinon la réponse est celle d'un client absent (404).
// La route n'existe que si serveur.ts la reçoit ; elle répond 503 tant que `ouvert()` est faux (fermé par défaut).
export interface SessionPortee {
  acteur: string;
  peutVoir(clientId: string): boolean;
}
export interface FicheBrute {
  nom: string;
  etat: "ok" | "a_aider" | "urgent" | "pause";
  formule: string;
  derniere_erreur: { code: string; message: string } | null;
  connexions: { total: number; a_reprendre: number };
  prochaine_echeance: string | null;
  abonnement: { formule: string; engagement: string | null };
  automatisations_actives: number;
  reglages: { versions: number };
  executions: { reussies_pourcent: number | null; en_attente: number };
  notes: { total: number; epinglees: number };
  factures: { en_attente: number };
}
export interface DepsFiche {
  ouvert(): boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  session(requete: FastifyRequest): Promise<SessionPortee>;
  lire(clientId: string): Promise<FicheBrute | null>;
}
const Params = z.strictObject({ id: z.uuid() });

// Liste blanche champ par champ : rien d'autre que ces valeurs ne sort (le bandeau ne porte jamais un contenu de message ou de donnée du client).
export function versFiche(f: FicheBrute) {
  return {
    bandeau: {
      nom: f.nom, etat: f.etat, formule: f.formule,
      derniere_erreur: f.derniere_erreur ? { code: f.derniere_erreur.code, message: f.derniere_erreur.message } : null,
      connexions: { total: f.connexions.total, a_reprendre: f.connexions.a_reprendre },
      prochaine_echeance: f.prochaine_echeance,
    },
    resume: {
      abonnement: { formule: f.abonnement.formule, engagement: f.abonnement.engagement },
      automatisations_actives: f.automatisations_actives,
      reglages: { versions: f.reglages.versions },
      connexions: { total: f.connexions.total, a_reprendre: f.connexions.a_reprendre },
      executions: { reussies_pourcent: f.executions.reussies_pourcent, en_attente: f.executions.en_attente },
      notes: { total: f.notes.total, epinglees: f.notes.epinglees },
      factures: { en_attente: f.factures.en_attente },
    },
  };
}

export function routeFiche(serveur: FastifyInstance, d: DepsFiche): void {
  serveur.get("/api/console/v1/clients/:id/fiche", { preHandler: d.exigerEquipe }, async (req) => {
    if (!d.ouvert()) throw new ErreurApi("porte_fermee", "Service indisponible.");
    const p = Params.safeParse(req.params);
    if (!p.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    if (!(await d.session(req)).peutVoir(p.data.id)) throw new ErreurApi("introuvable", "Ressource introuvable.");
    const fiche = await d.lire(p.data.id);
    if (!fiche) throw new ErreurApi("introuvable", "Ressource introuvable.");
    return versFiche(fiche);
  });
}
