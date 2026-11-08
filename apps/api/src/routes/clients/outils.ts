import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { calculer, type Gamme } from "../../compatibilite/calcul.js";
import type { DepotOutils } from "../../compatibilite/depot.js";
import { exigerDroit, type DepsDroits } from "../../droits/exiger-droit.js";
import { ErreurApi } from "../../plugins/erreurs.js";

// Outils du client et compatibilité (T3-17b) : lecture seule, réservée à l'équipe. Un client hors portée répond comme un client absent (404), sans lecture.
// La route n'existe que si serveur.ts la reçoit ; elle répond 503 tant que `ouvert()` est faux (fermé par défaut). Aucune variable d'environnement lue ici.
// `gammeConseillee` : port facultatif (adaptateur réel : T3-32) ; absent, la gamme est null, jamais une valeur écrite en dur.
export interface DepsOutils {
  ouvert(): boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  droits: DepsDroits;
  depot: DepotOutils;
  gammeConseillee?(codes: string[]): Promise<Record<string, Gamme>>;
}
const Params = z.strictObject({ id: z.uuid() });

export function routeOutils(serveur: FastifyInstance, d: DepsOutils): void {
  const droit = exigerDroit("lire", d.droits, { client: (r) => (r.params as { id?: unknown }).id });
  // Porte puis forme de l'identifiant avant le droit : un identifiant qui n'est pas un UUID rend 400, jamais un 404 de portée.
  const porteEtForme: preHandlerAsyncHookHandler = async (req) => {
    if (!d.ouvert()) throw new ErreurApi("porte_fermee", "Service indisponible.");
    if (!Params.safeParse(req.params).success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  };
  serveur.get("/api/console/v1/clients/:id/outils", { preHandler: [d.exigerEquipe, porteEtForme, droit] }, async (req) => {
    const p = Params.parse(req.params);
    const [outils, catalogue, connecteurs] = await Promise.all([d.depot.outils(p.id), d.depot.catalogue(), d.depot.connecteurs()]);
    const gammes = d.gammeConseillee ? await d.gammeConseillee(catalogue.map((a) => a.code)) : {};
    const c = calculer({ outils, catalogue, connecteurs, gammes });
    // Projection champ par champ : rien d'autre que ces valeurs ne sort.
    const evaluation = (e: (typeof c.compatibles)[number]) => ({
      code: e.code, nom: e.nom,
      raison: { code: e.raison.code, famille: e.raison.famille, ...(e.raison.outil !== undefined ? { outil: e.raison.outil } : {}) },
      fiche: e.fiche.map((f) => ({ famille: f.famille, outils_compatibles: [...f.outils_compatibles] })),
      gamme_conseillee: e.gamme_conseillee,
    });
    return {
      outils: outils.map((o) => ({ famille: o.famille, outil: o.outil, cree_le: o.cree_le })),
      compatibles: c.compatibles.map(evaluation),
      a_creer: c.a_creer.map(evaluation),
      impossibles: c.impossibles.map(evaluation),
    };
  });
}
