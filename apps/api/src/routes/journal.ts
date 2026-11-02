import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { Contexte } from "./reglages.js";
import type { LigneJournal } from "../journal-audit/contenu-canonique.js";
import { COLONNES, type Requete } from "../journal-audit/verifier.js";
import { ErreurApi } from "../plugins/erreurs.js";

// Lecture du journal d'audit pour l'équipe (C-401) : par entité et par période, en lecture seule (aucune route d'écriture).
// L'accès est celui de l'équipe : `exigerEquipe` est fourni par l'appelant (jeton de l'équipe, puis lecture avec le rôle console_equipe).
// La route n'est branchée dans serveur.ts que par la fiche qui câble les routes de l'équipe : tant qu'elle ne l'est pas, elle n'existe pas.
export interface FiltreJournal {
  entite: string;
  entiteId?: string;
  du?: string;
  au?: string;
  apres?: string;
  limite: number;
}

const LIMITE_MAX = 200;
const Parametres = z.strictObject({
  entite: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  entiteId: z.string().min(1).max(128).optional(),
  du: z.iso.datetime().optional(),
  au: z.iso.datetime().optional(),
  apres: z.string().regex(/^[0-9]{1,18}$/).optional(),
  limite: z.coerce.number().int().min(1).max(LIMITE_MAX).default(50),
});

// Période [du, au[ sur la date de création. Les valeurs vont en paramètres : jamais dans le texte SQL.
export async function lireJournalSql(requete: Requete, f: FiltreJournal): Promise<LigneJournal[]> {
  const sql = `SELECT ${COLONNES}
    FROM public.journal_audit AS journal_audit WHERE entite = $1 AND ($2::text IS NULL OR entite_id = $2) AND ($3::timestamptz IS NULL OR cree_le >= $3) AND ($4::timestamptz IS NULL OR cree_le < $4)
    AND ($5::bigint IS NULL OR journal_audit.id > $5::bigint) ORDER BY journal_audit.id LIMIT $6`;
  return (await requete(sql, [f.entite, f.entiteId ?? null, f.du ?? null, f.au ?? null, f.apres ?? null, f.limite])) as unknown as LigneJournal[];
}

export function routeJournal(serveur: FastifyInstance, o: { exigerEquipe: preHandlerAsyncHookHandler; lire: (f: FiltreJournal) => Promise<LigneJournal[]> }): void {
  serveur.get("/equipe/journal", { preHandler: o.exigerEquipe }, async (requete) => {
    const p = Parametres.safeParse(requete.query);
    if (!p.success || (p.data.du && p.data.au && Date.parse(p.data.du) >= Date.parse(p.data.au))) throw new ErreurApi("schema_invalide", "Requête invalide.");
    const { entite, entiteId, du, au, apres, limite } = p.data;
    const lignes = await o.lire({ entite, ...(entiteId ? { entiteId } : {}), ...(du ? { du } : {}), ...(au ? { au } : {}), ...(apres ? { apres } : {}), limite });
    return { lignes, suivant: lignes.length === limite ? (lignes[lignes.length - 1]?.id ?? null) : null };
  });
}

// Annulation en un clic (A-030, C-443) : le client actif et l'auteur viennent de la session, jamais du corps ; la ligne se désigne par son numéro seulement.
export function routeAnnulation(
  serveur: FastifyInstance,
  o: { exigerEquipe: preHandlerAsyncHookHandler; contexte: (requete: FastifyRequest) => Promise<Contexte>; annuler: (c: Contexte, idLigne: string) => Promise<{ entite: string; entite_id: string }> },
): void {
  serveur.post("/api/console/v1/journal/:id/annuler", { preHandler: o.exigerEquipe }, async (requete) => {
    const p = z.strictObject({ id: z.string().regex(/^[0-9]{1,18}$/) }).safeParse(requete.params);
    if (!p.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    return o.annuler(await o.contexte(requete), p.data.id);
  });
}
