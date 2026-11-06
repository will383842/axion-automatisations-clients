import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Coffre } from "../coffre/coffre.js";
import { avecClient } from "../db/client-actif.js";

// Clé d'IA propre du client (A-020, A-364, C-635). La valeur va au coffre (montage clients/, propre à CE client) et nulle part ailleurs : la base garde la référence,
// l'équipe voit l'état, jamais la valeur ni la référence. Aucune erreur, aucun retour ne recopie la valeur.
const FOURNISSEUR = /^[a-z][a-z0-9_.-]{0,63}$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export type EtatCle = "a_tester" | "active" | "refusee" | "desactivee";
export type CleVue = { id: string; fournisseur: string; etat: EtatCle };
export type EntreeCle = { tenantId: string; organisationId: string; fournisseur: string; valeur: string; acteur: string };
export interface DepsCle {
  coffre: Pick<Coffre, "rangerIdentifiant">;
  enregistrer(e: { tenantId: string; organisationId: string; fournisseur: string; reference: string; acteur: string }): Promise<{ id: string }>;
}

export class ErreurCle extends Error {
  constructor(readonly code: "fournisseur_invalide" | "coffre_indisponible" | "reference_etrangere") {
    super(code);
    this.name = "ErreurCle";
  }
}

export async function rangerCleClient(d: DepsCle, e: EntreeCle): Promise<CleVue> {
  if (!FOURNISSEUR.test(e.fournisseur)) throw new ErreurCle("fournisseur_invalide");
  let reference: string;
  try {
    reference = await d.coffre.rangerIdentifiant(e.tenantId, `ia:${e.fournisseur}`, e.valeur);
  } catch {
    // Le message du coffre n'est pas recopié : il pourrait contenir la valeur.
    throw new ErreurCle("coffre_indisponible");
  }
  // Jamais le montage technique/ d'AXION IA, jamais la référence d'un autre client : la forme est relue avant tout enregistrement.
  if (!new RegExp(`^bao:clients/${e.tenantId}/${UUID}$`).test(reference)) throw new ErreurCle("reference_etrangere");
  const { id } = await d.enregistrer({ tenantId: e.tenantId, organisationId: e.organisationId, fournisseur: e.fournisseur, reference, acteur: e.acteur });
  return { id, fournisseur: e.fournisseur, etat: "a_tester" };
}

export const enregistrerEnBase = (pool: Pool): DepsCle["enregistrer"] => async (e) => {
  const id = randomUUID();
  await avecClient(
    pool,
    e.tenantId,
    (c) => c.query("INSERT INTO cles_ia_client (tenant_id, id, organisation_id, fournisseur, reference_coffre, cree_par) VALUES ($1, $2, $3, $4, $5, $6)", [e.tenantId, id, e.organisationId, e.fournisseur, e.reference, e.acteur]),
    { acteur: e.acteur },
  );
  return { id };
};

// L'état seulement : ni la référence, ni la valeur.
export async function listerCles(pool: Pool, tenantId: string): Promise<CleVue[]> {
  const r = await avecClient(pool, tenantId, (c) => c.query("SELECT id, fournisseur, etat FROM cles_ia_client ORDER BY cree_le, id"));
  return r.rows as CleVue[];
}

// Désactivation définitive (la base refuse tout retour en arrière). Rend faux si la clé n'existe pas pour ce client ou l'est déjà.
export async function desactiverCle(pool: Pool, tenantId: string, id: string, acteur: string): Promise<boolean> {
  const r = await avecClient(pool, tenantId, (c) => c.query("UPDATE cles_ia_client SET etat = 'desactivee', desactivee_le = now() WHERE id = $1", [id]), { acteur });
  return (r.rowCount ?? 0) === 1;
}
