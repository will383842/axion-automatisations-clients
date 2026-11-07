import type { Pool } from "pg";
import { avecClient } from "../db/client-actif.js";
import { ErreurApi } from "../plugins/erreurs.js";
import type { DepsVue } from "../donnees/vue-client.js";
import type { EnvoisService } from "../envois/service.js";

// Trace et avis de la vue (T3-08a, B-069, C-009). Le journal ne reçoit que des codes fermés : jamais une adresse, un titre ni une donnée lue chez le client.
export type Evenement = "vue_client_ouverte" | "page_consultee" | "vue_client_fermee" | "demande_accord_envoyee";
export interface EntreeTrace { tenantId: string; acteur: string; evenement: Evenement; page?: string; expireLe?: Date; motif?: string; le: Date }
export interface PortTrace { ecrire(e: EntreeTrace): Promise<void> }
const PAGE = /^[a-z0-9-]{1,40}$/;
const interne = () => new ErreurApi("erreur_interne", "Erreur interne.");

// Passée en DepsVue.tracer : l'avis au client part AVANT la trace (avis en panne : pas de trace, donc pas de vue). L'atomicité SQL réelle est la dette du port d'envois.
export function consignerOuverture(d: { envois: EnvoisService; trace: PortTrace; maintenant(): Date }): DepsVue["tracer"] {
  return async (e) => {
    await d.envois.deposerService({ type: "avis_vue_client_ouverte", clientId: e.tenantId, cle: `avis_vue_client_ouverte:${e.tenantId}:${e.acteur}:${e.expireLe.toISOString()}`, categorie: "service" });
    await d.trace.ecrire({ tenantId: e.tenantId, acteur: e.acteur, evenement: "vue_client_ouverte", expireLe: e.expireLe, motif: e.motif, le: d.maintenant() });
  };
}

// Pas de trace, pas de page.
export async function tracerPage(d: { trace: PortTrace; maintenant(): Date }, tenantId: string, acteur: string, page: string): Promise<void> {
  if (typeof page !== "string" || !PAGE.test(page)) throw new ErreurApi("schema_invalide", "Requête invalide.");
  await d.trace.ecrire({ tenantId, acteur, evenement: "page_consultee", page, le: d.maintenant() }).catch(() => { throw interne(); });
}

export async function tracerFermeture(d: { trace: PortTrace; maintenant(): Date }, tenantId: string, acteur: string): Promise<void> {
  await d.trace.ecrire({ tenantId, acteur, evenement: "vue_client_fermee", le: d.maintenant() }).catch(() => { throw interne(); });
}

// Demande d'accord écrit (B-420) : un seul dépôt par jour et par client (la clé porte le jour). Elle n'enregistre aucun accord.
export async function demanderAccord(d: { envois: EnvoisService; trace: PortTrace; maintenant(): Date }, tenantId: string, acteur: string): Promise<void> {
  const le = d.maintenant();
  await d.envois.deposerService({ type: "demande_accord_vue_client", clientId: tenantId, cle: `demande_accord_vue_client:${tenantId}:${le.toISOString().slice(0, 10)}`, categorie: "service" }).catch(() => { throw interne(); });
  await d.trace.ecrire({ tenantId, acteur, evenement: "demande_accord_envoyee", le }).catch(() => { throw interne(); });
}

// Adaptateur SQL : public.audit_ajouter dans le client actif (la fonction refuse une ligne pour un autre client). Aucune migration : entité fixe « vue_client ».
export function traceSql(pool: Pool): PortTrace {
  return {
    ecrire: (e) => avecClient(pool, e.tenantId, async (c) => {
      const nouvelle = { evenement: e.evenement, le: e.le.toISOString(), ...(e.page ? { page: e.page } : {}), ...(e.expireLe ? { expire_le: e.expireLe.toISOString() } : {}), ...(e.motif ? { motif: e.motif } : {}) };
      await c.query("SELECT public.audit_ajouter($1::uuid, $2, 'insertion'::public.action_audit, 'vue_client', NULL, NULL, $3::jsonb)", [e.tenantId, e.acteur, JSON.stringify(nouvelle)]);
    }, { acteur: e.acteur }),
  };
}
