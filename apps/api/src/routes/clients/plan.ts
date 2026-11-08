import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { dateParis } from "../../commercial/lire-niveaux.ts";
import type { PlanClientLu, SourceBase, ValeursPlanLues } from "../../commercial/plan-client.ts";
import { ErreurApi } from "../../plugins/erreurs.js";
import type { SessionPortee } from "./fiche.js";

// Onglet Contrat et plan (T3-14a) : lecture seule du plan ENREGISTRÉ de chaque automatisation du client, jamais recalculé (aucun calcul de prix ici).
// Ordre fixe : interrupteur (503), identifiant (400), portée (404 sans lecture), dépôt. La route n'existe que si serveur.ts la reçoit ; fermée par défaut.
export interface DepsPlan {
  ouvert(): boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  session(requete: FastifyRequest): Promise<SessionPortee>;
  lire(clientId: string, jour: string): Promise<PlanClientLu>;
}
const Params = z.strictObject({ id: z.uuid() });

// Vocabulaire de l'écran : « grille » se dit « catalogue ». « personnalise » vaut vrai pour la seule source « client » (jamais par comparaison à la valeur par défaut).
type SourceEcran = "catalogue" | "defaut" | "client" | "instance";
const source = (s: SourceBase): SourceEcran => (s === "grille" ? "catalogue" : s);
const valeur = <T>(v: T, s: SourceBase) => ({ valeur: v, source: source(s), personnalise: s === "client" });
function valeurs(v: ValeursPlanLues) {
  return {
    formule: valeur(v.formule, v.sources.formule),
    frais_mise_en_place_ht_centimes: valeur(v.fraisMiseEnPlaceHtCentimes, v.sources.fraisMiseEnPlace),
    prix_recurrent_mensuel_ht_centimes: valeur(v.prixRecurrentMensuelHtCentimes, v.sources.prixRecurrentMensuel),
    periode_facturation_mois: valeur(v.periodeFacturationMois, v.sources.periodeFacturation),
    mode_avance: valeur(v.modeAvance, v.sources.modeAvance),
    maintenance_incluse_mois: valeur(v.maintenanceIncluseMois, v.sources.maintenanceIncluse),
    suite_maintenance: valeur(v.suiteMaintenance, v.sources.suiteMaintenance),
    engagement_mois: valeur(v.engagementMois, v.sources.engagement),
  };
}

// Liste blanche champ par champ : rien d'autre que ces valeurs ne sort. `acompte` reste nul (interrupteur fermé : aucun taux par défaut n'existe dans le code).
export function versPlanClient(l: PlanClientLu) {
  return {
    plans: l.instances.map((i) => ({
      instance_id: i.instanceId, automatisation: i.codeAutomatisation, etat: i.etat,
      plan: i.plan && {
        id: i.plan.id, auteur: i.plan.auteur, enregistre_le: i.plan.enregistreLe, valeurs: valeurs(i.plan.valeurs),
        phases: i.plan.phases.map((p) => ({ ordre: p.ordre, nature: p.nature, debut: p.debut, fin: p.fin, statut: p.statut, montant_ht_centimes: p.montantHtCentimes, periode_facturation_mois: p.periodeFacturationMois })),
      },
    })),
    conditions: l.conditions.map((c) => ({ id: c.id, type: c.type, valeurs: c.valeur, valide_du: c.valideDu, valide_au: c.valideAu, personnalise: true as const, auteur: c.auteur, modifie_le: c.modifieLe })),
    acompte: null,
  };
}

export function routePlan(serveur: FastifyInstance, d: DepsPlan): void {
  serveur.get("/api/console/v1/clients/:id/plan", { preHandler: d.exigerEquipe }, async (req) => {
    if (!d.ouvert()) throw new ErreurApi("porte_fermee", "Service indisponible.");
    const p = Params.safeParse(req.params);
    if (!p.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    if (!(await d.session(req)).peutVoir(p.data.id)) throw new ErreurApi("introuvable", "Ressource introuvable.");
    return versPlanClient(await d.lire(p.data.id, dateParis(new Date())));
  });
}
