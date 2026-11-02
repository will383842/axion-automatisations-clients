import type { NiveauxConnus, ValeurNiveau } from "@axion-auto/reglages-heritage";
import { PLATEFORME_ID } from "../db/schema/aides.ts";
import type { Requeteur } from "../instances/activer.ts";
import { CLES_SURCHARGEABLES_INSTANCE, ErreurPlan, TYPE_VERS_CLES, estHeritable, type TypeCondition } from "./heritage.ts";

// Lecture des niveaux d'une instance (T2-08). TOUTE lecture passe par le client de la transaction d'avecClient (tenant fixé, RLS forcée) : jamais un pool direct,
// et chaque requête nomme son tenant_id en plus de la RLS. Aucun SELECT *. Les montants (bigint) arrivent en texte et sont bornés à 2^53 − 1.
// Niveaux : la grille de prix (catalogue commun) puis les conditions par défaut forment le niveau PLATEFORME (les secondes l'emportent, C-138) ; le préréglage publié du métier ;
// les conditions du client ; les réglages de l'instance. Le niveau « automatisation » est réservé aux défauts de modèle des modules (T4-30).
export type Condition = { type: string; valeur: Record<string, unknown> };
export type Grille = { fraisMiseEnPlaceCentimes: number; tarifMensuelCentimes: number; maintenanceIncluseMois: number };
export type Entrees = {
  grille: Grille | null;
  defauts: Condition[];
  metier: { donnees: Record<string, unknown>; version: number } | null;
  client: Condition[];
  instance: Record<string, unknown>;
};

function poser(niveau: Record<string, ValeurNiveau>, cle: string, v: ValeurNiveau, ambigu: Set<string>): void {
  if (ambigu.has(cle)) throw new ErreurPlan(`valeur_ambigue:${cle}`);
  ambigu.add(cle);
  niveau[cle] = v;
}

export function assemblerNiveaux(e: Entrees): NiveauxConnus {
  const global: Record<string, ValeurNiveau> = {};
  if (e.grille) {
    global["frais_mise_en_place_centimes"] = { valeur: e.grille.fraisMiseEnPlaceCentimes, origine: "grille" };
    global["tarif_mensuel_centimes"] = { valeur: e.grille.tarifMensuelCentimes, origine: "grille" };
    global["maintenance_incluse_mois"] = { valeur: e.grille.maintenanceIncluseMois, origine: "grille" };
  }
  // Niveaux partagés avec les modules : une clé qui n'est pas commerciale est ignorée ici (elle appartient aux réglages des modules).
  const ambigusDefaut = new Set<string>();
  for (const c of e.defauts) for (const [cle, valeur] of Object.entries(c.valeur)) if (estHeritable(cle)) poser(global, cle, { valeur, origine: "defaut" }, ambigusDefaut);
  const metier: Record<string, ValeurNiveau> = {};
  for (const [cle, valeur] of Object.entries(e.metier?.donnees ?? {})) if (estHeritable(cle)) metier[cle] = { valeur, version: e.metier?.version };
  // Conditions du client : une clé inconnue ou rangée sous un autre type est une erreur, pas une valeur ignorée.
  const client: Record<string, ValeurNiveau> = {};
  const ambigusClient = new Set<string>();
  for (const c of e.client) {
    const permises = (Object.hasOwn(TYPE_VERS_CLES, c.type) ? TYPE_VERS_CLES[c.type as TypeCondition] : []) as readonly string[];
    for (const [cle, valeur] of Object.entries(c.valeur)) {
      if (!permises.includes(cle)) throw new ErreurPlan(`cle_non_heritable:${cle}`);
      poser(client, cle, { valeur }, ambigusClient);
    }
  }
  const instance: Record<string, ValeurNiveau> = {};
  for (const [cle, valeur] of Object.entries(e.instance)) {
    if (!(CLES_SURCHARGEABLES_INSTANCE as readonly string[]).includes(cle)) throw new ErreurPlan(`surcharge_instance_interdite:${cle}`);
    instance[cle] = { valeur };
  }
  return { global, metier, client, instance };
}

const entier = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new ErreurPlan("valeur_invalide:montant_lu");
  return n;
};
const objet = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ErreurPlan("valeur_invalide:condition");
  return v as Record<string, unknown>;
};
const conditions = (rows: Record<string, unknown>[]): Condition[] => rows.map((r) => ({ type: String(r["type"]), valeur: objet(r["valeur"]) }));
const VALIDE = "(valide_du IS NULL OR valide_du <= $2::date) AND (valide_au IS NULL OR valide_au >= $2::date)";

export async function lireNiveaux(client: Requeteur, tenantId: string, instance: { organisationId: string; automatisationId: string | null }, options: { metierId?: string | null; surcharges?: Record<string, unknown>; date: string }): Promise<NiveauxConnus> {
  let grille: Grille | null = null;
  let metier: Entrees["metier"] = null;
  if (instance.automatisationId) {
    const g = (await client.query("SELECT montant_installation_centimes, montant_mensuel_centimes, maintenance_incluse_mois FROM grilles_prix WHERE automatisation_id = $1 ORDER BY cree_le DESC, id DESC LIMIT 1", [instance.automatisationId])).rows[0];
    if (g) grille = { fraisMiseEnPlaceCentimes: entier(g["montant_installation_centimes"]), tarifMensuelCentimes: entier(g["montant_mensuel_centimes"]), maintenanceIncluseMois: entier(g["maintenance_incluse_mois"]) };
    if (options.metierId) {
      const m = (await client.query("SELECT donnees, version FROM prereglages_metier WHERE automatisation_id = $1 AND metier_id = $2 AND statut = 'publie' ORDER BY version DESC LIMIT 1", [instance.automatisationId, options.metierId])).rows[0];
      if (m) metier = { donnees: objet(m["donnees"]), version: entier(m["version"]) };
    }
  }
  const defauts = await client.query(`SELECT type, valeur FROM conditions_par_defaut WHERE tenant_id = $1 AND ${VALIDE} ORDER BY id`, [PLATEFORME_ID, options.date]);
  const duClient = await client.query(`SELECT type, valeur FROM conditions_commerciales WHERE tenant_id = $1 AND organisation_id = $3 AND ${VALIDE} ORDER BY id`, [tenantId, options.date, instance.organisationId]);
  return assemblerNiveaux({ grille, defauts: conditions(defauts.rows), metier, client: conditions(duClient.rows), instance: options.surcharges ?? {} });
}
