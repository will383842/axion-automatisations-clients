import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ErreurApi } from "../../plugins/erreurs.js";
import { DESACTIVABLES, NON_DESACTIVABLES, type PreferencesLues } from "../../portail/notifications.js";

// Préférences de notification de l'utilisateur connecté (B-141, B-186). Le client et l'utilisateur viennent de la session que la route fournit,
// jamais de l'URL, du corps, d'un en-tête ou d'un cookie (C-536). Fermée par défaut : `ouvert` doit être vrai.
export type Ecriture = { evenement: string; activee: boolean } | { resumeHebdomadaire: boolean };
export interface DepotPreferences {
  lire(tenantId: string, utilisateur: string): Promise<PreferencesLues>;
  ecrire(tenantId: string, utilisateur: string, ecriture: Ecriture): Promise<void>;
}
export interface DepsRouteNotifications {
  ouvert: boolean;
  session(requete: FastifyRequest): Promise<{ tenantId: string; acteur: string }>;
  depot: DepotPreferences;
}

const Corps = z.union([z.strictObject({ evenement: z.string().min(1).max(64), activee: z.boolean() }), z.strictObject({ resumeHebdomadaire: z.boolean() })]);
const CHEMIN = "/api/portail/v1/notifications/preferences";

export function routeNotificationsPortail(serveur: FastifyInstance, d: DepsRouteNotifications): void {
  serveur.get(CHEMIN, async (requete) => {
    if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
    const { tenantId, acteur } = await d.session(requete);
    const lu = await d.depot.lire(tenantId, acteur);
    const ligne = (evenement: string, desactivable: boolean) => ({ evenement, desactivable, activee: !(desactivable && lu.desactivees.includes(evenement)) });
    return { preferences: [...NON_DESACTIVABLES.map((e) => ligne(e, false)), ...DESACTIVABLES.map((e) => ligne(e, true))], resumeHebdomadaire: lu.resumeHebdomadaire };
  });

  serveur.put(CHEMIN, async (requete) => {
    if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
    const corps = Corps.safeParse(requete.body);
    if (!corps.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    const { tenantId, acteur } = await d.session(requete);
    if ("evenement" in corps.data && !DESACTIVABLES.includes(corps.data.evenement)) throw new ErreurApi("regle_metier", "Cet envoi ne peut pas être désactivé.");
    await d.depot.ecrire(tenantId, acteur, corps.data);
    return { ok: true };
  });
}
