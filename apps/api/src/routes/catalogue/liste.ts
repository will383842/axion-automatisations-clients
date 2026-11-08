import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { exigerDroit, type DepsDroits } from "../../droits/exiger-droit.js";
import { ErreurApi } from "../../plugins/erreurs.js";

// Liste minimale du catalogue (T3-31a2, B-342) : réservée à l'équipe, filtre par métier et pagination par code. AUCUN prix, aucun tri, aucune recherche (T3-40 étend ce fichier).
//   GET /api/console/v1/catalogue?metier=<code>&limite=<1 à 100>&curseur=<code>
// Fermée (503) tant que `ouvert` est faux ; branchée dans serveur.ts seulement si l'appelant la fournit. Ordre des crochets : porte, équipe, droit `lire`, puis seulement la requête.
export interface LigneCatalogue { id: string; code: string; nom: string; statut: string; visibilite: string; metiers: string[] }
export interface DemandeListe { metiers: string[] | null; curseur: string | null; limite: number }
export interface ServiceListe {
  metiersConnus(codes: string[]): Promise<string[]>;
  /** Rend au plus `limite + 1` lignes triées par code : la ligne en plus dit qu'il y a une suite. */
  lister(demande: DemandeListe): Promise<LigneCatalogue[]>;
}
export interface DepsListeCatalogue {
  ouvert: boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  droits: DepsDroits;
  service: ServiceListe;
}

const ENTIER = /^[0-9]{1,3}$/;
const Requete = z.strictObject({
  metier: z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]), z.array(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/)).min(1).max(20).optional()),
  limite: z.string().regex(ENTIER).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  curseur: z.string().regex(/^[A-Z]{2,6}-[0-9]{3,5}$/).optional(),
});

export function routeListeCatalogue(serveur: FastifyInstance, d: DepsListeCatalogue): void {
  const porte = async () => { if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible."); };
  const droit = exigerDroit("lire", d.droits, { globale: "Catalogue commun : aucune donnée de client." });
  serveur.get("/api/console/v1/catalogue", { preHandler: [porte, d.exigerEquipe, droit] }, async (requete: FastifyRequest) => {
    const lu = Requete.safeParse(requete.query);
    if (!lu.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    const metiers = lu.data.metier ? [...new Set(lu.data.metier)] : null;
    const limite = lu.data.limite ?? 50;
    if (metiers && (await d.service.metiersConnus(metiers)).length !== metiers.length) throw new ErreurApi("regle_metier", "Métier inconnu.");
    const lignes = await d.service.lister({ metiers, curseur: lu.data.curseur ?? null, limite });
    const page = lignes.slice(0, limite);
    return {
      automatisations: page.map((l) => ({ id: l.id, code: l.code, nom: l.nom, statut: l.statut, visibilite: l.visibilite, metiers: [...l.metiers].sort() })),
      suivant: lignes.length > limite ? (page.at(-1)?.code ?? null) : null,
    };
  });
}

// Dépôt SQL : toutes les valeurs passent en paramètres ($1 métiers, $2 curseur, $3 limite). Lecture seule, aucune table de prix.
export type Lecteur = (texte: string, valeurs: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
export function depotSqlListe(lire: Lecteur): ServiceListe {
  return {
    async metiersConnus(codes) {
      return (await lire("SELECT code FROM metiers WHERE code = ANY($1::text[])", [codes])).rows.map((r) => String(r["code"]));
    },
    async lister(demande) {
      const { rows } = await lire(
        `SELECT a.id, a.code, a.nom, a.statut::text AS statut, a.visibilite::text AS visibilite,
           ARRAY(SELECT m2.code FROM automatisation_metiers am2 JOIN metiers m2 ON m2.id = am2.metier_id WHERE am2.automatisation_id = a.id ORDER BY m2.code) AS metiers
         FROM automatisations a
         WHERE ($1::text[] IS NULL OR EXISTS (SELECT 1 FROM automatisation_metiers am JOIN metiers m ON m.id = am.metier_id WHERE am.automatisation_id = a.id AND m.code = ANY($1)))
           AND ($2::text IS NULL OR a.code > $2)
         ORDER BY a.code LIMIT $3 + 1`,
        [demande.metiers, demande.curseur, demande.limite],
      );
      return rows.map((r) => ({ id: String(r["id"]), code: String(r["code"]), nom: String(r["nom"]), statut: String(r["statut"]), visibilite: String(r["visibilite"]), metiers: (r["metiers"] as string[]) ?? [] }));
    },
  };
}
