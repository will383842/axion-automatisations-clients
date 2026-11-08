import type { Requeteur } from "../instances/activer.ts";

// Lecture du plan ENREGISTRÉ d'un client (T3-14a, onglet Contrat et plan). Rien n'est recalculé : ni la grille, ni les valeurs par défaut, ni les niveaux ne sont lus ici.
// À appeler dans la transaction d'avecClient du client concerné (RLS forcée) ; chaque requête nomme tenant_id en plus de la RLS, aucun SELECT *, aucune écriture.
// Les montants (bigint) arrivent de pg en texte : UNE seule conversion, `centimes`, qui refuse tout ce qui n'est pas un entier sûr positif ou nul.
// Limite écrite : le journal n'a qu'un index (tenant_id, id) ; le « dernier changement » se lit par sous-requête LATERAL ... ORDER BY id DESC LIMIT 1, sans index dédié (migration hors de cette tâche).
export type SourceBase = "grille" | "defaut" | "client" | "instance";
export type StatutPhase = "terminee" | "en_cours" | "a_venir";
export type ValeursPlanLues = {
  formule: string;
  fraisMiseEnPlaceHtCentimes: number;
  prixRecurrentMensuelHtCentimes: number;
  periodeFacturationMois: number;
  modeAvance: string;
  maintenanceIncluseMois: number;
  suiteMaintenance: string;
  engagementMois: number;
  sources: Record<"formule" | "fraisMiseEnPlace" | "prixRecurrentMensuel" | "periodeFacturation" | "modeAvance" | "maintenanceIncluse" | "suiteMaintenance" | "engagement", SourceBase>;
};
export type PhaseLue = { ordre: number; nature: string; debut: string; fin: string | null; statut: StatutPhase; montantHtCentimes: number; periodeFacturationMois: number };
export type PlanLu = { id: string; auteur: string; enregistreLe: string | null; valeurs: ValeursPlanLues; phases: PhaseLue[] };
export type InstanceLue = { instanceId: string; codeAutomatisation: string; etat: string; plan: PlanLu | null };
export type ConditionLue = { id: string; type: string; valeur: Record<string, unknown>; valideDu: string | null; valideAu: string | null; auteur: string; modifieLe: string | null };
export type PlanClientLu = { instances: InstanceLue[]; conditions: ConditionLue[] };

type Ligne = Record<string, unknown>;
export class ErreurLecturePlan extends Error {}

// Seule conversion de montant : jamais d'arrondi, jamais de valeur devinée.
export function centimes(v: unknown): number {
  const n = typeof v === "string" ? (/^\d{1,16}$/.test(v) ? Number(v) : Number.NaN) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new ErreurLecturePlan("montant_illisible");
  return n;
}
const texte = (v: unknown, nom: string): string => {
  if (typeof v !== "string" || v === "") throw new ErreurLecturePlan(`champ_illisible:${nom}`);
  return v;
};
const entier = (v: unknown, nom: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new ErreurLecturePlan(`champ_illisible:${nom}`);
  return v;
};
const SOURCES: readonly string[] = ["grille", "defaut", "client", "instance"];
const source = (v: unknown, nom: string): SourceBase => {
  if (typeof v !== "string" || !SOURCES.includes(v)) throw new ErreurLecturePlan(`champ_illisible:${nom}`);
  return v as SourceBase;
};
// Horodatage complet ISO 8601 (jamais « Invalid Date » à l'écran) ; null si le journal n'a pas de ligne.
const instant = (v: unknown, nom: string): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ErreurLecturePlan(`champ_illisible:${nom}`);
  return d.toISOString();
};
const jourOuNul = (v: unknown, nom: string): string | null => (v === null || v === undefined ? null : jour(v, nom));
function jour(v: unknown, nom: string): string {
  const s = texte(v, nom);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ErreurLecturePlan(`champ_illisible:${nom}`);
  return s;
}

// Fin INCLUSE : la phase qui finit aujourd'hui est encore en cours. Comparaison de chaînes AAAA-MM-JJ, `aujourdhui` est le jour de Paris donné par l'appelant.
export function statutPhase(debut: string, fin: string | null, aujourdhui: string): StatutPhase {
  if (aujourdhui < debut) return "a_venir";
  if (fin !== null && fin < aujourdhui) return "terminee";
  return "en_cours";
}

const INSTANCES = `SELECT i.id AS instance_id, i.code_automatisation, i.etat, i.formule, p.id AS plan_id, p.auteur AS plan_auteur, j.cree_le AS enregistre_le,
  p.frais_mise_en_place_ht_centimes, p.prix_recurrent_mensuel_ht_centimes, p.periode_facturation_mois, p.mode_avance, p.maintenance_incluse_mois, p.suite_maintenance, p.engagement_mois,
  p.source_formule, p.source_frais_mise_en_place, p.source_prix_recurrent_mensuel, p.source_periode_facturation, p.source_mode_avance, p.source_maintenance_incluse, p.source_suite_maintenance, p.source_engagement
FROM instances i
LEFT JOIN plans_commerciaux p ON p.tenant_id = i.tenant_id AND p.instance_id = i.id
LEFT JOIN LATERAL (SELECT cree_le FROM journal_audit WHERE tenant_id = $1 AND entite = 'plans_commerciaux' AND entite_id = p.id::text ORDER BY id DESC LIMIT 1) j ON true
WHERE i.tenant_id = $1
ORDER BY i.cree_le, i.id`;
const PHASES = `SELECT plan_id, ordre, nature, to_char(debut, 'YYYY-MM-DD') AS debut, to_char(fin, 'YYYY-MM-DD') AS fin, montant_ht_centimes, periode_facturation_mois
FROM phases_plan WHERE tenant_id = $1 AND plan_id = ANY($2::uuid[]) ORDER BY plan_id, ordre`;
// Conditions du client valides au jour demandé (même fenêtre que lire-niveaux : début inclus, fin exclue) ; dernier changement lu au journal.
const CONDITIONS = `SELECT c.id, c.type, c.valeur, to_char(c.valide_du, 'YYYY-MM-DD') AS valide_du, to_char(c.valide_au, 'YYYY-MM-DD') AS valide_au, coalesce(j.acteur, c.auteur) AS auteur, j.cree_le AS modifie_le
FROM conditions_commerciales c
LEFT JOIN LATERAL (SELECT acteur, cree_le FROM journal_audit WHERE tenant_id = $1 AND entite = 'conditions_commerciales' AND entite_id = c.id::text ORDER BY id DESC LIMIT 1) j ON true
WHERE c.tenant_id = $1 AND (c.valide_du IS NULL OR c.valide_du <= $2::date) AND (c.valide_au IS NULL OR c.valide_au > $2::date)
ORDER BY c.type, c.id`;

function valeursDe(l: Ligne): ValeursPlanLues {
  return {
    formule: texte(l["formule"], "formule"),
    fraisMiseEnPlaceHtCentimes: centimes(l["frais_mise_en_place_ht_centimes"]),
    prixRecurrentMensuelHtCentimes: centimes(l["prix_recurrent_mensuel_ht_centimes"]),
    periodeFacturationMois: entier(l["periode_facturation_mois"], "periode_facturation_mois"),
    modeAvance: texte(l["mode_avance"], "mode_avance"),
    maintenanceIncluseMois: entier(l["maintenance_incluse_mois"], "maintenance_incluse_mois"),
    suiteMaintenance: texte(l["suite_maintenance"], "suite_maintenance"),
    engagementMois: entier(l["engagement_mois"], "engagement_mois"),
    sources: {
      formule: source(l["source_formule"], "source_formule"), fraisMiseEnPlace: source(l["source_frais_mise_en_place"], "source_frais_mise_en_place"),
      prixRecurrentMensuel: source(l["source_prix_recurrent_mensuel"], "source_prix_recurrent_mensuel"), periodeFacturation: source(l["source_periode_facturation"], "source_periode_facturation"),
      modeAvance: source(l["source_mode_avance"], "source_mode_avance"), maintenanceIncluse: source(l["source_maintenance_incluse"], "source_maintenance_incluse"),
      suiteMaintenance: source(l["source_suite_maintenance"], "source_suite_maintenance"), engagement: source(l["source_engagement"], "source_engagement"),
    },
  };
}

export async function lirePlanClient(client: Requeteur, tenantId: string, aujourdhui: string): Promise<PlanClientLu> {
  const lignes = (await client.query(INSTANCES, [tenantId])).rows;
  const idsPlans = lignes.flatMap((l) => (l["plan_id"] ? [texte(l["plan_id"], "plan_id")] : []));
  const phasesParPlan = new Map<string, PhaseLue[]>();
  if (idsPlans.length > 0) {
    for (const p of (await client.query(PHASES, [tenantId, idsPlans])).rows) {
      const debut = jour(p["debut"], "debut");
      const fin = jourOuNul(p["fin"], "fin");
      const phase: PhaseLue = { ordre: entier(p["ordre"], "ordre"), nature: texte(p["nature"], "nature"), debut, fin, statut: statutPhase(debut, fin, aujourdhui), montantHtCentimes: centimes(p["montant_ht_centimes"]), periodeFacturationMois: entier(p["periode_facturation_mois"], "periode_facturation_mois") };
      const cle = texte(p["plan_id"], "plan_id");
      phasesParPlan.set(cle, [...(phasesParPlan.get(cle) ?? []), phase]);
    }
  }
  const instances = lignes.map((l): InstanceLue => ({
    instanceId: texte(l["instance_id"], "instance_id"), codeAutomatisation: texte(l["code_automatisation"], "code_automatisation"), etat: texte(l["etat"], "etat"),
    plan: l["plan_id"] ? { id: texte(l["plan_id"], "plan_id"), auteur: texte(l["plan_auteur"], "plan_auteur"), enregistreLe: instant(l["enregistre_le"], "enregistre_le"), valeurs: valeursDe(l), phases: phasesParPlan.get(texte(l["plan_id"], "plan_id")) ?? [] } : null,
  }));
  const conditions = (await client.query(CONDITIONS, [tenantId, aujourdhui])).rows.map((c): ConditionLue => {
    const valeur = c["valeur"];
    if (typeof valeur !== "object" || valeur === null || Array.isArray(valeur)) throw new ErreurLecturePlan("champ_illisible:valeur");
    return { id: texte(c["id"], "id"), type: texte(c["type"], "type"), valeur: valeur as Record<string, unknown>, valideDu: jourOuNul(c["valide_du"], "valide_du"), valideAu: jourOuNul(c["valide_au"], "valide_au"), auteur: texte(c["auteur"], "auteur"), modifieLe: instant(c["modifie_le"], "modifie_le") };
  });
  return { instances, conditions };
}
