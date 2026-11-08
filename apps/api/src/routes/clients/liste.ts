import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { filtrerClients, paginer, SchemaFiltres, versDto, VUE_PRETE_ABONNEMENTS, type DepotVues, type FiltresClients, type LigneClient } from "../../clients/liste.js";
import { autorise } from "../../droits/matrice.js";
import type { MembreDroits } from "../../droits/exiger-droit.js";
import { couvreTousLesClients, filtrerParPortee } from "../../droits/portee.js";
import { ErreurApi } from "../../plugins/erreurs.js";
import { routeExport } from "./export.js";
import { routeVues } from "./vues.js";

// Espace « Clients » (T3-10). Routes de l'équipe, derrière l'interrupteur `ouvert` (fermé par défaut : 503). Le membre vient de la session, jamais de la requête.
export interface TraceExport { sujet: string; filtres: FiltresClients; lignes: number; empreinte: string }
export interface DepsClients {
  ouvert(): boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  membre(requete: FastifyRequest): Promise<MembreDroits | undefined>;
  clients: { toutes(): Promise<LigneClient[]> };
  vues: DepotVues;
  tracerExport(e: TraceExport): Promise<void>;
}
export const BASE = "/api/console/v1/clients";
export const lire = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};
export const porteFermee = (d: DepsClients): preHandlerAsyncHookHandler => async () => {
  if (!d.ouvert()) throw new ErreurApi("porte_fermee", "Service indisponible.");
};
// Droit « lire » puis portée : seuls les clients de la portée du membre sortent (liste, export). Portée vide = rien (échec fermé).
export async function membreAutorise(d: DepsClients, requete: FastifyRequest): Promise<MembreDroits> {
  const m = await d.membre(requete).catch(() => undefined);
  if (!m?.actif || !autorise(m.role, "lire")) throw new ErreurApi("action_interdite", "Action non permise.");
  return m;
}
export async function clientsVisibles(d: DepsClients, m: MembreDroits): Promise<LigneClient[]> {
  const toutes = await d.clients.toutes();
  if (couvreTousLesClients(m)) return toutes;
  const ok = new Set(filtrerParPortee(m, toutes.map((l) => l.id)));
  return toutes.filter((l) => ok.has(l.id));
}
// Filtres d'une vue : la vue d'un autre membre est introuvable (404), jamais refusée.
export async function filtresDeLaVue(d: DepsClients, m: MembreDroits, vue: string | undefined): Promise<FiltresClients | undefined> {
  if (vue === undefined) return undefined;
  if (vue === VUE_PRETE_ABONNEMENTS.id) return VUE_PRETE_ABONNEMENTS.filtres;
  const v = await d.vues.lire(m.sujet, vue);
  if (!v) throw new ErreurApi("introuvable", "Ressource introuvable.");
  return v.filtres;
}

const Requete = SchemaFiltres.extend({ vue: z.string().max(64).optional(), curseur: z.string().max(400).optional(), taille: z.coerce.number().int().min(1).max(200).default(50) });

export function routeClients(serveur: FastifyInstance, d: DepsClients): void {
  const pre = { preHandler: [porteFermee(d), d.exigerEquipe] };
  serveur.get(BASE, pre, async (req) => {
    const { vue, curseur, taille, ...f } = lire(Requete, req.query);
    const m = await membreAutorise(d, req);
    const filtres = { ...(await filtresDeLaVue(d, m, vue)), ...f };
    let p;
    try { p = paginer(filtrerClients(await clientsVisibles(d, m), filtres), curseur, taille); } catch { throw new ErreurApi("schema_invalide", "Requête invalide."); }
    return { lignes: p.lignes.map(versDto), curseur_suivant: p.curseurSuivant };
  });
  routeVues(serveur, d, pre);
  routeExport(serveur, d, pre);
}
