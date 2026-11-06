import { z } from "zod";
import { ErreurApi } from "../plugins/erreurs.js";
import { ROLES_EQUIPE_ADMIS } from "../routes/donnees.js";
import type { SessionDonnees } from "./service.js";

// Vue « comme le client » (A-005, partie 2b ; B-070, C-006) : l'équipe ne lit le contenu d'une base qu'avec un accord écrit valide de CE client,
// pendant 60 minutes, en lecture seule (le service refuse toute écriture pendant la vue), avec une trace visible du client.
export const DUREE_VUE_MS = 60 * 60 * 1000;
export interface EvenementVue { tenantId: string; acteur: string; action: "vue_client_ouverte"; motif: string; expireLe: Date; visibleDuClient: true }
export interface VueRangee { acteur: string; tenantId: string; expireLe: Date }
// Stock en mémoire du processus : une vue par (acteur, client), oubliée à son terme. Perdu au redémarrage : la vue doit alors être rouverte (fermé par défaut).
export function creerStockVues(maintenant: () => Date) {
  const vues = new Map<string, VueRangee>();
  const cle = (acteur: string, tenantId: string) => JSON.stringify([acteur, tenantId]);
  return {
    ranger(vue: VueRangee): void { vues.set(cle(vue.acteur, vue.tenantId), { ...vue }); },
    lire(acteur: string, tenantId: string): VueRangee | undefined {
      const v = vues.get(cle(acteur, tenantId));
      if (v && !(maintenant() < v.expireLe)) { vues.delete(cle(acteur, tenantId)); return undefined; }
      return v ? { ...v } : undefined;
    },
  };
}
export interface DepsVue {
  accordValide(tenantId: string, instant: Date): Promise<boolean>;
  tracer(evenement: EvenementVue): Promise<void>;
  // Fin de l'intervention en cours : la vue ne dure jamais plus longtemps qu'elle. Exigée : sans elle (ou si sa lecture échoue), pas de vue.
  finIntervention(tenantId: string, instant: Date): Promise<Date | undefined>;
  // Range la vue côté serveur : le service ne croit que cette copie, jamais ce que la session porte.
  ranger(vue: VueRangee): void;
  maintenant(): Date;
}

export async function ouvrirVueClient(d: DepsVue, session: SessionDonnees, tenantId: string, motif: string, roleEquipe: string | undefined): Promise<SessionDonnees> {
  // Le rôle dans l'équipe est exigé ici même (liste fermée, comme la route) : lecteur, qualifieur, rôle inconnu ou absent sont refusés avant tout accord.
  if (session.role !== "equipe" || !roleEquipe || !ROLES_EQUIPE_ADMIS.has(roleEquipe)) throw new ErreurApi("action_interdite", "Action interdite.");
  const id = z.uuid().safeParse(tenantId);
  const m = typeof motif === "string" ? motif.trim() : "";
  if (!id.success || m.length === 0 || m.length > 500) throw new ErreurApi("schema_invalide", "Requête invalide.");
  const maintenant = d.maintenant();
  // Ferme par défaut : un accord illisible vaut pas d'accord.
  if (!(await d.accordValide(id.data, maintenant).catch(() => false))) throw new ErreurApi("action_interdite", "Action interdite.");
  // Fin d'intervention illisible ou absente : pas de vue (jamais 60 minutes « par défaut »).
  const fin = await d.finIntervention(id.data, maintenant).catch(() => undefined);
  if (!fin || !(fin.getTime() > maintenant.getTime())) throw new ErreurApi("action_interdite", "Action interdite.");
  const expireLe = new Date(Math.min(fin.getTime(), maintenant.getTime() + DUREE_VUE_MS));
  // Pas de trace, pas de vue.
  await d.tracer({ tenantId: id.data, acteur: session.acteur, action: "vue_client_ouverte", motif: m, expireLe, visibleDuClient: true }).catch(() => { throw new ErreurApi("erreur_interne", "Erreur interne."); });
  d.ranger({ acteur: session.acteur, tenantId: id.data, expireLe });
  return { ...session, tenantId: id.data, vue: { tenantId: id.data, expireLe } };
}

// Accord valide = un accord écrit daté ET une intervention en cours à cet instant. `db` est la connexion de la console déjà limitée à ce client (avecClient, RLS).
export const accordValideSql = (db: { requete(texte: string, valeurs: unknown[]): Promise<unknown[]> }) => async (tenantId: string, instant: Date): Promise<boolean> =>
  (await db.requete("SELECT 1 AS ok FROM visibilite_acces WHERE tenant_id = $1 AND cardinality(accords_ecrits_le) > 0 AND intervention_debut <= $2 AND intervention_fin > $2 LIMIT 1", [tenantId, instant])).length > 0;
