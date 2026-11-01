import { bigint, check, date, foreignKey, integer, jsonb, pgEnum, text, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tableClient } from "./aides.ts";
import { formuleInstance, instances, organisations } from "./clients.ts";
import { sourceCondition, typeCondition } from "./canaux.ts";

// Plan commercial (C5, lot 2) : abonnements, plans, phases, échéances, conditions du client (ADR 0052). Aucun calcul ici (héritage : T2-08).
// Argent : `bigint` en centimes, lu en `number` (mode « number »), sans jamais dépasser 2^53 − 1 : un CHECK le borne. Taux en points de base (entier).
// Vocabulaires provisoires : une valeur s'ajoute plus tard (additif), jamais ne se renomme. La formule vient de `formule_instance` (clients.ts).
export const sourceValeur = pgEnum("source_valeur", ["grille", "defaut", "client", "instance"]);
export const modeAvance = pgEnum("mode_avance", ["aucune", "acompte", "periode_entiere"]);
export const suiteMaintenance = pgEnum("suite_maintenance", ["arret", "reconduction"]);
export const natureLignePlan = pgEnum("nature_ligne_plan", ["mise_en_place", "recurrente", "maintenance"]);
export const statutEcheance = pgEnum("statut_echeance", ["prevue", "emise", "payee", "annulee"]);

const MAX_ENTIER = "9007199254740991";
const centimes = (nom: string) => bigint(nom, { mode: "number" });

export const conditionsCommerciales = tableClient(
  "conditions_commerciales",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    type: typeCondition("type").notNull(),
    valeur: jsonb("valeur").notNull(),
    // Une condition du client porte toujours la source `client` ; les valeurs d'AXION vivent dans conditions_par_defaut (T2-02).
    source: sourceCondition("source").notNull().default("client"),
    valideDu: date("valide_du"),
    valideAu: date("valide_au"),
    auteur: text("auteur").notNull(),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "conditions_commerciales_organisation_fk", columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] }),
      check("conditions_commerciales_source_client", sql`${t["source"]} = 'client'`),
      check("conditions_commerciales_auteur_non_vide", sql`length(btrim(${t["auteur"]})) > 0`),
      check("conditions_commerciales_validite", sql`${t["valideDu"]} IS NULL OR ${t["valideAu"]} IS NULL OR ${t["valideAu"]} >= ${t["valideDu"]}`),
    ],
  },
);

export const abonnements = tableClient(
  "abonnements",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    conditionsId: uuid("conditions_id"),
    debut: date("debut").notNull(),
    fin: date("fin"),
    // Forme des quotas vérifiée par Zod dans l'application ; la base garantit seulement un objet.
    quotas: jsonb("quotas").notNull().default(sql`'{}'::jsonb`),
    periodeFacturationMois: integer("periode_facturation_mois").notNull(),
    modeAvance: modeAvance("mode_avance").notNull().default("aucune"),
    acomptePointsDeBase: integer("acompte_points_de_base"),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "abonnements_organisation_fk", columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] }),
      foreignKey({ name: "abonnements_conditions_fk", columns: [t["tenantId"] as never, t["conditionsId"] as never], foreignColumns: [conditionsCommerciales.tenantId, conditionsCommerciales.id] }),
      check("abonnements_periode_valide", sql`${t["periodeFacturationMois"]} IN (1, 6, 12)`),
      check("abonnements_dates", sql`${t["fin"]} IS NULL OR ${t["fin"]} >= ${t["debut"]}`),
      check("abonnements_quotas_objet", sql`jsonb_typeof(${t["quotas"]}) = 'object'`),
      check("abonnements_acompte_taux", sql`${t["acomptePointsDeBase"]} BETWEEN 0 AND 10000`),
    ],
  },
);

// Un plan par instance (unique (tenant_id, instance_id)). Chaque valeur porte sa source (colonnes source_*, NOT NULL).
export const plansCommerciaux = tableClient(
  "plans_commerciaux",
  {
    id: uuid("id").notNull(),
    instanceId: uuid("instance_id").notNull(),
    formule: formuleInstance("formule").notNull(),
    fraisMiseEnPlaceCentimes: centimes("frais_mise_en_place_centimes").notNull(),
    prixRecurrentMensuelCentimes: centimes("prix_recurrent_mensuel_centimes").notNull(),
    periodeFacturationMois: integer("periode_facturation_mois").notNull(),
    modeAvance: modeAvance("mode_avance").notNull(),
    maintenanceIncluseMois: integer("maintenance_incluse_mois").notNull(),
    suiteMaintenance: suiteMaintenance("suite_maintenance").notNull(),
    engagementMois: integer("engagement_mois").notNull(),
    sourceFormule: sourceValeur("source_formule").notNull(),
    sourceFraisMiseEnPlace: sourceValeur("source_frais_mise_en_place").notNull(),
    sourcePrixRecurrentMensuel: sourceValeur("source_prix_recurrent_mensuel").notNull(),
    sourcePeriodeFacturation: sourceValeur("source_periode_facturation").notNull(),
    sourceModeAvance: sourceValeur("source_mode_avance").notNull(),
    sourceMaintenanceIncluse: sourceValeur("source_maintenance_incluse").notNull(),
    sourceSuiteMaintenance: sourceValeur("source_suite_maintenance").notNull(),
    sourceEngagement: sourceValeur("source_engagement").notNull(),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "plans_commerciaux_instance_fk", columns: [t["tenantId"] as never, t["instanceId"] as never], foreignColumns: [instances.tenantId, instances.id] }),
      unique("plans_commerciaux_tenant_id_instance_id_unique").on(t["tenantId"] as never, t["instanceId"] as never),
      // V1 : seule la formule abonnement est permise ; achat et installation avec maintenance viennent en V2 (levée de ce CHECK par un ADR).
      check("plans_commerciaux_formule_v1", sql`${t["formule"]} = 'abonnement'`),
      check("plans_commerciaux_frais_entier", sql`${t["fraisMiseEnPlaceCentimes"]} BETWEEN 0 AND ${sql.raw(MAX_ENTIER)}`),
      check("plans_commerciaux_prix_entier", sql`${t["prixRecurrentMensuelCentimes"]} BETWEEN 0 AND ${sql.raw(MAX_ENTIER)}`),
      check("plans_commerciaux_periode_valide", sql`${t["periodeFacturationMois"]} IN (1, 6, 12)`),
      check("plans_commerciaux_mois_positifs", sql`${t["maintenanceIncluseMois"]} >= 0 AND ${t["engagementMois"]} >= 0`),
    ],
  },
);

export const phasesPlan = tableClient(
  "phases_plan",
  {
    id: uuid("id").notNull(),
    planId: uuid("plan_id").notNull(),
    ordre: integer("ordre").notNull(),
    debut: date("debut").notNull(),
    fin: date("fin"),
    nature: natureLignePlan("nature").notNull(),
    montantCentimes: centimes("montant_centimes").notNull(),
    periodeFacturationMois: integer("periode_facturation_mois").notNull(),
    idPlanHub: text("id_plan_hub"),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "phases_plan_plan_fk", columns: [t["tenantId"] as never, t["planId"] as never], foreignColumns: [plansCommerciaux.tenantId, plansCommerciaux.id] }),
      unique("phases_plan_tenant_id_plan_id_ordre_unique").on(t["tenantId"] as never, t["planId"] as never, t["ordre"] as never),
      check("phases_plan_ordre_positif", sql`${t["ordre"]} >= 1`),
      check("phases_plan_dates", sql`${t["fin"]} IS NULL OR ${t["fin"]} >= ${t["debut"]}`),
      check("phases_plan_montant_entier", sql`${t["montantCentimes"]} BETWEEN 0 AND ${sql.raw(MAX_ENTIER)}`),
      check("phases_plan_periode_valide", sql`${t["periodeFacturationMois"]} IN (1, 6, 12)`),
    ],
  },
);

// Une échéance par (client, plan, début de période). Les avoirs ne sont pas des échéances (T2-05). `facture_id` : clé étrangère ajoutée par T2-05.
export const echeances = tableClient(
  "echeances",
  {
    id: uuid("id").notNull(),
    planId: uuid("plan_id").notNull(),
    debutPeriode: date("debut_periode").notNull(),
    finPeriode: date("fin_periode").notNull(),
    montantHtCentimes: centimes("montant_ht_centimes").notNull(),
    dateEmission: date("date_emission"),
    datePaiement: date("date_paiement"),
    statut: statutEcheance("statut").notNull().default("prevue"),
    factureId: uuid("facture_id"),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "echeances_plan_fk", columns: [t["tenantId"] as never, t["planId"] as never], foreignColumns: [plansCommerciaux.tenantId, plansCommerciaux.id] }),
      unique("echeances_tenant_id_plan_id_debut_periode_unique").on(t["tenantId"] as never, t["planId"] as never, t["debutPeriode"] as never),
      check("echeances_periode_ordonnee", sql`${t["finPeriode"]} > ${t["debutPeriode"]}`),
      check("echeances_montant_entier", sql`${t["montantHtCentimes"]} BETWEEN 0 AND ${sql.raw(MAX_ENTIER)}`),
      check("echeances_paiement_coherent", sql`(${t["statut"]} = 'payee') = (${t["datePaiement"]} IS NOT NULL)`),
    ],
  },
);
