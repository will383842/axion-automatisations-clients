import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { Coffre } from "../../coffre/coffre.js";
import { desactiverCle, enregistrerEnBase, ErreurCle, listerCles, rangerCleClient } from "../../ia/cle-client.js";
import { MODELES_ADMIS } from "../../ia/modeles-admis.js";
import { ErreurApi } from "../../plugins/erreurs.js";

// Routes de l'équipe pour l'IA d'un client (T4-34a). Le client actif et l'auteur viennent de la session de l'équipe (T1A-08), jamais d'un paramètre ni du corps.
// Interrupteur FERMÉ par défaut : rien n'est enregistré tant que `interrupteurOuvert` n'est pas vrai. Non branchée dans serveur.ts (aucune tâche ne câble encore ces routes).
export interface DepsIa {
  interrupteurOuvert?: boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  contexte(requete: FastifyRequest): Promise<{ tenantId: string; acteur: string }>;
  coffre: Pick<Coffre, "rangerIdentifiant">;
  pool: Pool;
}

const Cle = z.strictObject({ organisationId: z.uuid(), fournisseur: z.string().min(1).max(64), valeur: z.string().min(8).max(4096) });
const Params = z.strictObject({ id: z.uuid() });
const lire = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};

export function routeIa(serveur: FastifyInstance, d: DepsIa): void {
  if (d.interrupteurOuvert !== true) return;
  const base = "/api/console/v1/ia";
  const o = { preHandler: d.exigerEquipe };
  serveur.get(`${base}/modeles`, o, async () => ({ modeles: MODELES_ADMIS.map((m) => ({ code: m.code, horsUe: m.horsUe })) }));
  serveur.get(`${base}/cles`, o, async (req) => ({ cles: await listerCles(d.pool, (await d.contexte(req)).tenantId) }));
  serveur.post(`${base}/cles`, o, async (req, rep) => {
    const c = await d.contexte(req);
    const e = lire(Cle, req.body);
    try {
      return rep.status(201).send(await rangerCleClient({ coffre: d.coffre, enregistrer: enregistrerEnBase(d.pool) }, { ...c, ...e }));
    } catch (erreur) {
      // Message fixe : ni la valeur ni le détail du coffre ne sortent.
      if (erreur instanceof ErreurCle) throw new ErreurApi("regle_metier", "La clé n'a pas pu être rangée.");
      throw erreur;
    }
  });
  serveur.post(`${base}/cles/:id/desactiver`, o, async (req, rep) => {
    const c = await d.contexte(req);
    const ok = await desactiverCle(d.pool, c.tenantId, lire(Params, req.params).id, c.acteur);
    if (!ok) throw new ErreurApi("introuvable", "Ressource introuvable.");
    return rep.status(200).send({ etat: "desactivee" });
  });
}
