import { z } from "zod";
import { ErreurApi } from "../plugins/erreurs.js";
import type { SessionDonnees } from "./service.js";

// Vue « comme le client » (A-005, partie 2b ; B-070, C-006) : l'équipe ne lit le contenu d'une base qu'avec un accord écrit valide de CE client,
// pendant 60 minutes, en lecture seule (le service refuse toute écriture pendant la vue), avec une trace visible du client.
export const DUREE_VUE_MS = 60 * 60 * 1000;
export interface EvenementVue { tenantId: string; acteur: string; action: "vue_client_ouverte"; motif: string; expireLe: Date; visibleDuClient: true }
export interface DepsVue {
  accordValide(tenantId: string, instant: Date): Promise<boolean>;
  tracer(evenement: EvenementVue): Promise<void>;
  // Fin de l'intervention en cours : la vue ne dure jamais plus longtemps qu'elle.
  finIntervention?(tenantId: string, instant: Date): Promise<Date | undefined>;
  maintenant(): Date;
}

export async function ouvrirVueClient(d: DepsVue, session: SessionDonnees, tenantId: string, motif: string): Promise<SessionDonnees> {
  if (session.role !== "equipe") throw new ErreurApi("action_interdite", "Action interdite.");
  const id = z.uuid().safeParse(tenantId);
  const m = typeof motif === "string" ? motif.trim() : "";
  if (!id.success || m.length === 0 || m.length > 500) throw new ErreurApi("schema_invalide", "Requête invalide.");
  const maintenant = d.maintenant();
  // Ferme par défaut : un accord illisible vaut pas d'accord.
  if (!(await d.accordValide(id.data, maintenant).catch(() => false))) throw new ErreurApi("action_interdite", "Action interdite.");
  const fin = d.finIntervention ? await d.finIntervention(id.data, maintenant).catch(() => undefined) : undefined;
  const plafond = maintenant.getTime() + DUREE_VUE_MS;
  const expireLe = new Date(fin && fin.getTime() < plafond ? fin.getTime() : plafond);
  // Pas de trace, pas de vue.
  await d.tracer({ tenantId: id.data, acteur: session.acteur, action: "vue_client_ouverte", motif: m, expireLe, visibleDuClient: true }).catch(() => { throw new ErreurApi("erreur_interne", "Erreur interne."); });
  return { ...session, tenantId: id.data, vue: { tenantId: id.data, expireLe } };
}

// Accord valide = un accord écrit daté ET une intervention en cours à cet instant. `db` est la connexion de la console déjà limitée à ce client (avecClient, RLS).
export const accordValideSql = (db: { requete(texte: string, valeurs: unknown[]): Promise<unknown[]> }) => async (tenantId: string, instant: Date): Promise<boolean> =>
  (await db.requete("SELECT 1 AS ok FROM visibilite_acces WHERE tenant_id = $1 AND cardinality(accords_ecrits_le) > 0 AND intervention_debut <= $2 AND intervention_fin > $2 LIMIT 1", [tenantId, instant])).length > 0;
