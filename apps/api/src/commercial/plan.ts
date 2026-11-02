import { NIVEAUX, resoudre, type NiveauxConnus, type Resolu } from "@axion-auto/reglages-heritage";
import { randomUUID } from "node:crypto";
import { formuleInstance } from "../db/schema/clients.ts";
import type { Requeteur } from "../instances/activer.ts";
import { CLES_HERITABLES, ErreurPlan, MAX_ENTIER, remiseBps, type CleHeritable } from "./heritage.ts";
import { lireNiveaux } from "./lire-niveaux.ts";

export { ErreurPlan };

// Plan commercial d'une instance (T2-08, A-143, C-138). `calculerPlan` est pure ; `preparerPlan` lit les niveaux ; `enregistrerPlan` écrit.
// Montants en centimes entiers, hors taxes, jamais de flottant. Chaque valeur du plan garde sa source (colonnes source_*).
// Un plan ne se modifie pas (ADR 0052 § 6 sexies) : le remplacer demande de lever l'unicité (tenant_id, instance_id), donc une migration, hors de cette tâche.
export type SourcePlan = "grille" | "defaut" | "client" | "instance";
export type ValeurPlan = { valeur: unknown; source: Resolu["source"]; version: number | undefined; origine: string | undefined };
export type PlanPrepare = {
  instanceId?: string;
  formule: string;
  fraisMiseEnPlaceHtCentimes: number;
  prixRecurrentMensuelHtCentimes: number;
  periodeFacturationMois: number;
  modeAvance: string;
  maintenanceIncluseMois: number;
  suiteMaintenance: string;
  engagementMois: number;
  sources: Record<"formule" | "fraisMiseEnPlace" | "prixRecurrentMensuel" | "periodeFacturation" | "modeAvance" | "maintenanceIncluse" | "suiteMaintenance" | "engagement", SourcePlan>;
  // Toutes les valeurs résolues (avant remise), y compris garantie, délai et seuil, qui n'ont pas de colonne dans le plan.
  valeurs: Partial<Record<CleHeritable, ValeurPlan>>;
};

type Regle = { nul: boolean; ok: (v: unknown) => boolean };
const entier = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_ENTIER;
const parmi = (...vals: string[]) => (v: unknown) => typeof v === "string" && vals.includes(v);
const REGLES: Record<CleHeritable, Regle> = {
  remise_bps: { nul: true, ok: (v) => entier(v) && (v as number) < 10000 }, // 100 % ou plus : refusé
  frais_mise_en_place_centimes: { nul: false, ok: entier },
  tarif_mensuel_centimes: { nul: false, ok: entier },
  engagement_mois: { nul: false, ok: entier },
  maintenance_incluse_mois: { nul: false, ok: entier },
  suite_maintenance: { nul: false, ok: parmi("arret", "reconduction") },
  garantie_mois: { nul: true, ok: entier },
  delai_jours: { nul: true, ok: entier },
  seuil_alerte_bps: { nul: true, ok: (v) => entier(v) && (v as number) <= 10000 },
  periode_facturation_mois: { nul: false, ok: (v) => v === 1 || v === 6 || v === 12 },
  mode_avance: { nul: false, ok: parmi("aucune", "acompte", "periode_entiere") },
};

const rang = (r: Resolu) => NIVEAUX.indexOf(r.source) * 2 + (r.origine === "grille" ? 0 : 1);
const sourcePlan = (r: Resolu): SourcePlan => (r.source === "instance" ? "instance" : r.source === "client" ? "client" : r.source === "global" && r.origine === "grille" ? "grille" : "defaut");

export function calculerPlan(niveaux: NiveauxConnus, formule: string): PlanPrepare {
  if (!(formuleInstance.enumValues as readonly string[]).includes(formule)) throw new ErreurPlan("formule_inconnue");
  const r: Partial<Record<CleHeritable, Resolu>> = {};
  const valeurs: PlanPrepare["valeurs"] = {};
  for (const cle of CLES_HERITABLES) {
    const trouve = resoudre(cle, niveaux);
    if (!trouve) continue;
    const regle = REGLES[cle];
    if (trouve.valeur === null ? !regle.nul : !regle.ok(trouve.valeur)) throw new ErreurPlan(`valeur_invalide:${cle}`);
    r[cle] = trouve;
    valeurs[cle] = { valeur: trouve.valeur, source: trouve.source, version: trouve.version, origine: trouve.origine };
  }
  const requis = (cle: CleHeritable): Resolu => {
    const v = r[cle];
    if (!v) throw new ErreurPlan(`valeur_manquante:${cle}`);
    return v;
  };
  const bps = (r.remise_bps?.valeur as number | null | undefined) ?? 0;
  const net = (cle: "frais_mise_en_place_centimes" | "tarif_mensuel_centimes") => {
    const brut = requis(cle);
    const montant = brut.valeur as number;
    const retenue = bps > 0 && r.remise_bps ? (rang(r.remise_bps) > rang(brut) ? r.remise_bps : brut) : brut;
    return { montant: montant - remiseBps(montant, bps), source: sourcePlan(retenue) };
  };
  const frais = net("frais_mise_en_place_centimes");
  const prix = net("tarif_mensuel_centimes");
  const src = (cle: CleHeritable) => sourcePlan(requis(cle));
  return {
    formule,
    fraisMiseEnPlaceHtCentimes: frais.montant,
    prixRecurrentMensuelHtCentimes: prix.montant,
    periodeFacturationMois: requis("periode_facturation_mois").valeur as number,
    modeAvance: requis("mode_avance").valeur as string,
    maintenanceIncluseMois: requis("maintenance_incluse_mois").valeur as number,
    suiteMaintenance: requis("suite_maintenance").valeur as string,
    engagementMois: requis("engagement_mois").valeur as number,
    // La formule vient de l'instance (A-006) : deux instances d'un même client peuvent en porter deux.
    sources: { formule: "instance", fraisMiseEnPlace: frais.source, prixRecurrentMensuel: prix.source, periodeFacturation: src("periode_facturation_mois"), modeAvance: src("mode_avance"), maintenanceIncluse: src("maintenance_incluse_mois"), suiteMaintenance: src("suite_maintenance"), engagement: src("engagement_mois") },
    valeurs,
  };
}

export type OptionsPlan = { metierId?: string | null; surcharges?: Record<string, unknown>; date?: string };

// À appeler dans la transaction d'avecClient du client concerné.
export async function preparerPlan(client: Requeteur, tenantId: string, instanceId: string, options: OptionsPlan = {}): Promise<PlanPrepare> {
  const ligne = (await client.query("SELECT organisation_id, automatisation_id, formule FROM instances WHERE tenant_id = $1 AND id = $2", [tenantId, instanceId])).rows[0];
  if (!ligne) throw new ErreurPlan("instance_introuvable");
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const niveaux = await lireNiveaux(client, tenantId, { organisationId: String(ligne["organisation_id"]), automatisationId: (ligne["automatisation_id"] as string | null) ?? null }, { ...options, date });
  return { ...calculerPlan(niveaux, String(ligne["formule"])), instanceId };
}

// Écrit l'unique plan de l'instance. Le journal d'audit se remplit par la base. `motif` est exigé (traçabilité de l'appelant) mais la base n'a pas de colonne pour le ranger : dette.
export async function enregistrerPlan(client: Requeteur, tenantId: string, plan: PlanPrepare, auteur: string, motif: string): Promise<string> {
  if (!plan.instanceId) throw new ErreurPlan("instance_introuvable");
  if (auteur.trim() === "" || motif.trim() === "") throw new ErreurPlan("auteur_et_motif_obligatoires");
  const id = randomUUID();
  const s = plan.sources;
  try {
    await client.query(
      `INSERT INTO plans_commerciaux (tenant_id, id, instance_id, frais_mise_en_place_ht_centimes, prix_recurrent_mensuel_ht_centimes, periode_facturation_mois, mode_avance, maintenance_incluse_mois, suite_maintenance, engagement_mois,
        source_formule, source_frais_mise_en_place, source_prix_recurrent_mensuel, source_periode_facturation, source_mode_avance, source_maintenance_incluse, source_suite_maintenance, source_engagement, auteur)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [tenantId, id, plan.instanceId, plan.fraisMiseEnPlaceHtCentimes, plan.prixRecurrentMensuelHtCentimes, plan.periodeFacturationMois, plan.modeAvance, plan.maintenanceIncluseMois, plan.suiteMaintenance, plan.engagementMois,
        s.formule, s.fraisMiseEnPlace, s.prixRecurrentMensuel, s.periodeFacturation, s.modeAvance, s.maintenanceIncluse, s.suiteMaintenance, s.engagement, auteur],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new ErreurPlan("plan_existant");
    throw e;
  }
  return id;
}
