import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { EXCEPTIONS_UNICITE } from "../../../../../packages/contrats/src/c5/invariants.ts";
import { TABLES_CLIENT } from "./aides.ts";
import { abonnements, conditionsCommerciales, echeances, modeAvance, phasesPlan, plansCommerciaux, schemaQuotas, schemaValeurCondition, sourceValeur, statutEcheance } from "./commercial.ts";
import { instances, organisations } from "./clients.ts";

// Contrôles sans base de données du schéma et de la migration 0008 ; les essais contre PostgreSQL sont dans db/commercial.int.test.ts (job socle-integration).
const migration = readFileSync(new URL("../../../drizzle/0008_commercial.sql", import.meta.url), "utf8");
type Table = Parameters<typeof getTableConfig>[0];
const colonnes = (t: Table) => getTableConfig(t).columns.map((c) => c.name);
const contraintes = (t: Table) => getTableConfig(t).checks.map((c) => c.name);
const uniques = (t: Table) => getTableConfig(t).uniqueConstraints.map((u) => u.columns.map((c) => c.name));
const droits = (table: string, role = "console_app") => [...migration.matchAll(new RegExp(`GRANT ([A-Z, ]+(?:\\([^)]*\\))?) ON TABLE "public"\\."${table}" TO ${role}`, "g"))].map((m) => m[1]);
const TABLES = ["abonnements", "plans_commerciaux", "phases_plan", "echeances", "conditions_commerciales"];
const VALEURS = ["formule", "frais_mise_en_place", "prix_recurrent_mensuel", "periode_facturation", "mode_avance", "maintenance_incluse", "suite_maintenance", "engagement"];

describe("plan commercial : schéma et migration 0008", () => {
  it("[A-041] @argent un plan commercial lié à une instance dit ce qu'elle paie (mise en place, mensuel) et sa période", () => {
    expect(colonnes(plansCommerciaux)).toEqual(expect.arrayContaining(["tenant_id", "instance_id", "frais_mise_en_place_ht_centimes", "prix_recurrent_mensuel_ht_centimes", "periode_facturation_mois"]));
    expect(uniques(plansCommerciaux)).toContainEqual(["tenant_id", "instance_id"]);
    expect(migration).toContain('CONSTRAINT "plans_commerciaux_instance_fk" FOREIGN KEY ("tenant_id","instance_id")');
  });

  it("[A-143] @argent chaque valeur du plan porte sa source", () => {
    for (const v of VALEURS) {
      expect(colonnes(plansCommerciaux), v).toContain(`source_${v}`);
      expect(migration).toContain(`"source_${v}" "source_valeur" NOT NULL`);
    }
    expect(sourceValeur.enumValues).toEqual(["grille", "defaut", "client", "instance"]);
    expect(colonnes(plansCommerciaux)).toEqual(expect.arrayContaining(["maintenance_incluse_mois", "suite_maintenance", "engagement_mois", "mode_avance"]));
  });

  it("[A-006] la formule n'a qu'une seule source : instances.formule, aucune copie dans les tables du plan, ni dans la migration", () => {
    expect(colonnes(instances)).toContain("formule");
    for (const t of [organisations, abonnements, plansCommerciaux, phasesPlan, echeances, conditionsCommerciales]) expect(colonnes(t), getTableConfig(t).name).not.toContain("formule");
    // Seule la source de la formule reste dans le plan (source_formule) : jamais la valeur elle-même.
    expect(migration).not.toMatch(/"formule"|formule_instance|formule_v1/);
    expect(contraintes(plansCommerciaux)).not.toContain("plans_commerciaux_formule_v1");
    expect(migration).toContain('ALTER TABLE "public"."instances" ADD COLUMN "plan_commercial" uuid');
  });

  it("[A-145] @argent tout montant d'argent dit s'il est hors taxes : plus aucune colonne en centimes sans _ht", () => {
    for (const t of [plansCommerciaux, phasesPlan, echeances]) for (const c of colonnes(t).filter((n) => n.endsWith("_centimes"))) expect(c, getTableConfig(t).name).toMatch(/_ht_centimes$/);
    expect(migration).not.toMatch(/(?<!_ht)_centimes/);
  });

  it("[A-125] les quotas et la valeur d'une condition sont vérifiés par Zod : objet de nombres entiers positifs, objet JSON", () => {
    expect(schemaQuotas.safeParse({ messages: 10 }).success).toBe(true);
    for (const mauvais of [[1], "5", null, { messages: -1 }, { messages: 1.5 }, { messages: "10" }, { "": 1 }]) expect(schemaQuotas.safeParse(mauvais).success, JSON.stringify(mauvais)).toBe(false);
    expect(schemaValeurCondition.safeParse({ points_de_base: 500, liste: [1, "a"] }).success).toBe(true);
    for (const mauvais of [[1], "5", null, 5]) expect(schemaValeurCondition.safeParse(mauvais).success, String(mauvais)).toBe(false);
  });

  it("[A-125] un abonnement refuse une période de facturation hors 1, 6, 12", () => {
    expect(colonnes(abonnements)).toEqual(expect.arrayContaining(["organisation_id", "conditions_id", "debut", "fin", "quotas", "periode_facturation_mois", "mode_avance", "acompte_points_de_base"]));
    expect(migration).toContain(`CONSTRAINT "abonnements_periode_valide" CHECK ("abonnements"."periode_facturation_mois" IN (1, 6, 12))`);
    expect(migration).toContain(`CONSTRAINT "plans_commerciaux_periode_valide" CHECK ("plans_commerciaux"."periode_facturation_mois" IN (1, 6, 12))`);
    expect(modeAvance.enumValues.length).toBeGreaterThan(1);
  });

  it("[A-144] deux phases d'un plan ne peuvent pas avoir le même ordre", () => {
    expect(colonnes(phasesPlan)).toEqual(expect.arrayContaining(["plan_id", "ordre", "debut", "fin", "nature", "montant_ht_centimes", "periode_facturation_mois", "id_plan_hub"]));
    expect(uniques(phasesPlan)).toContainEqual(["tenant_id", "plan_id", "ordre"]);
  });

  it("[A-145] @argent une échéance est unique par (client, plan, début de période), jamais sans tenant_id", () => {
    expect(uniques(echeances)).toContainEqual(["tenant_id", "plan_id", "debut_periode"]);
    expect(migration).toContain('CONSTRAINT "echeances_tenant_id_plan_id_debut_periode_unique" UNIQUE("tenant_id","plan_id","debut_periode")');
    expect(colonnes(echeances)).toEqual(expect.arrayContaining(["fin_periode", "montant_ht_centimes", "date_emission", "date_paiement", "statut", "facture_id"]));
    expect(statutEcheance.enumValues).toContain("payee");
  });

  it("[A-145] @argent un montant non entier ou négatif est refusé : bigint en centimes, jamais numeric, CHECK >= 0 et borne 2^53", () => {
    expect(migration).not.toMatch(/numeric|decimal|real|double precision|float|money/i);
    for (const c of ["frais_mise_en_place_ht_centimes", "prix_recurrent_mensuel_ht_centimes"]) expect(migration).toContain(`"${c}" bigint NOT NULL`);
    expect(migration).toContain(`CHECK ("echeances"."montant_ht_centimes" BETWEEN 0 AND 9007199254740991)`);
    expect(migration).toContain(`CHECK ("phases_plan"."montant_ht_centimes" BETWEEN 0 AND 9007199254740991)`);
    expect(migration).toContain(`CHECK ("plans_commerciaux"."prix_recurrent_mensuel_ht_centimes" BETWEEN 0 AND 9007199254740991)`);
    // Taux en points de base : entier, de 0 à 10000.
    expect(migration).toContain(`CHECK ("abonnements"."acompte_points_de_base" BETWEEN 0 AND 10000)`);
    // Le montant d'une échéance ne se modifie jamais après coup.
    expect(droits("echeances").join()).not.toContain("montant_ht_centimes");
  });

  it("[A-146] @argent conditions_commerciales : auteur = appelant à l'insertion et à la modification, comme les autres tables d'argent", () => {
    const acteur = `WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''))`;
    expect(migration).toContain(`CREATE POLICY auteur_insertion ON "public"."conditions_commerciales" AS RESTRICTIVE FOR INSERT TO console_app ${acteur}`);
    expect(migration).toContain(`CREATE POLICY auteur_modification ON "public"."conditions_commerciales" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) ${acteur}`);
    expect(droits("conditions_commerciales").join()).toMatch(/UPDATE \("valide_au", "auteur"\)/);
    expect(droits("conditions_commerciales").join()).not.toMatch(/"valeur"|"type"/);
  });

  it("[A-146] une condition du client porte la source client, son auteur et ses dates", () => {
    expect(colonnes(conditionsCommerciales)).toEqual(expect.arrayContaining(["organisation_id", "type", "valeur", "source", "valide_du", "valide_au", "auteur"]));
    expect(migration).toContain(`CONSTRAINT "conditions_commerciales_source_client" CHECK ("conditions_commerciales"."source" = 'client')`);
    expect(migration).toContain(`CONSTRAINT "conditions_commerciales_auteur_non_vide" CHECK (length(btrim("conditions_commerciales"."auteur")) > 0)`);
    expect(migration).toContain('"auteur" text NOT NULL');
    expect(contraintes(conditionsCommerciales)).toContain("conditions_commerciales_validite");
  });

  it("[A-146] @isolation console_app ne modifie pas les conditions par défaut et ne lit pas celles de B", () => {
    // La migration 0008 ne touche pas conditions_par_defaut (créée en 0006, lecture seule pour console_app).
    expect(migration).not.toMatch(/conditions_par_defaut/);
    expect(migration).toContain('CREATE POLICY isolation_client ON "public"."conditions_commerciales" FOR ALL TO console_app');
    expect(droits("conditions_commerciales").join()).not.toMatch(/DELETE|TRUNCATE/);
  });

  it("[A-119] chaque table a ENABLE, FORCE, ses deux politiques, un index sur tenant_id, aucun DELETE ni TRUNCATE, le déclencheur d'audit", () => {
    expect(TABLES_CLIENT.map((t) => t.nom)).toEqual(expect.arrayContaining(TABLES));
    for (const t of TABLES) {
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" ENABLE ROW LEVEL SECURITY`);
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" FORCE ROW LEVEL SECURITY`);
      expect(migration, t).toContain(`CREATE POLICY isolation_client ON "public"."${t}" FOR ALL TO console_app`);
      expect(migration, t).toContain(`CREATE POLICY lecture_equipe ON "public"."${t}" FOR SELECT TO console_equipe`);
      expect(migration, t).toContain(`CREATE INDEX "${t}_tenant_id_idx" ON "${t}" USING btree ("tenant_id")`);
      expect(migration, t).toContain(`CREATE TRIGGER ${t}_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."${t}" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire()`);
      expect(droits(t).join(), t).not.toMatch(/DELETE|TRUNCATE/);
    }
    expect(migration).not.toMatch(/portail_app|TO PUBLIC/i);
    expect(migration).not.toMatch(/GRANT[^;]*\b(TRUNCATE|REFERENCES|TRIGGER|ALL|DELETE)\b[^;]*TO console_(app|equipe)/i);
  });

  it("[A-126] @argent le plan d'une instance appartient à CETTE instance : clé étrangère (tenant_id, id, plan_commercial) vers (tenant_id, instance_id, id)", () => {
    expect(uniques(plansCommerciaux)).toContainEqual(["tenant_id", "instance_id", "id"]);
    expect(migration).toContain('CONSTRAINT "plans_commerciaux_tenant_id_instance_id_id_unique" UNIQUE("tenant_id","instance_id","id")');
    expect(migration).toMatch(/ADD CONSTRAINT "instances_plan_commercial_fk" FOREIGN KEY \("tenant_id","id","plan_commercial"\) REFERENCES "public"\."plans_commerciaux"\("tenant_id","instance_id","id"\)/);
  });

  it("[A-126] @argent console_app lit le lien instance → plan : SELECT (plan_commercial) accordé, la liste de colonnes de 0007 ne l'incluant pas", () => {
    expect(migration).toContain('GRANT SELECT ("plan_commercial") ON TABLE "public"."instances" TO console_app');
    // Jamais de droit sur toute la table : on ajoute la seule colonne (les colonnes de copie restent cachées au client).
    expect(migration).not.toMatch(/GRANT (SELECT|ALL)[^(]*ON TABLE "public"\."instances"/);
  });

  it("[A-145] @argent chaque table d'argent porte un auteur non vide, non vide, et la base impose que ce soit l'appelant (politiques restrictives à l'insertion et à la modification)", () => {
    for (const [t, table] of [["abonnements", abonnements], ["plans_commerciaux", plansCommerciaux], ["phases_plan", phasesPlan], ["echeances", echeances]] as const) {
      expect(colonnes(table), t).toContain("auteur");
      expect(migration, t).toContain(`CONSTRAINT "${t}_auteur_non_vide" CHECK (length(btrim("${t}"."auteur")) > 0)`);
    }
    for (const t of ["abonnements", "phases_plan", "echeances"]) expect(droits(t).join(), t).toMatch(/UPDATE \([^)]*"auteur"/);
    expect(droits("plans_commerciaux").join()).not.toContain("UPDATE");
    const acteur = `WITH CHECK (auteur = NULLIF(current_setting('app.acteur', true), ''))`;
    for (const t of ["plans_commerciaux", "phases_plan", "echeances", "abonnements"]) {
      expect(migration, t).toContain(`CREATE POLICY auteur_insertion ON "public"."${t}" AS RESTRICTIVE FOR INSERT TO console_app ${acteur}`);
      expect(migration, t).toContain(`CREATE POLICY auteur_modification ON "public"."${t}" AS RESTRICTIVE FOR UPDATE TO console_app USING (true) ${acteur}`);
    }
  });

  it("[A-145] @argent une échéance se crée prevue, sans date d'émission, sans facture et sans date de paiement (politique restrictive à l'insertion)", () => {
    expect(migration).toContain(`CREATE POLICY creation_echeance ON "public"."echeances" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (statut = 'prevue' AND date_paiement IS NULL AND date_emission IS NULL AND facture_id IS NULL)`);
    expect(contraintes(echeances)).toContain("echeances_paiement_apres_emission");
    expect(migration).toContain(`CONSTRAINT "echeances_paiement_apres_emission" CHECK ("echeances"."date_paiement" IS NULL OR "echeances"."date_emission" IS NULL OR "echeances"."date_paiement" >= "echeances"."date_emission")`);
  });

  it("[A-145] @argent une échéance ne sort jamais de payee ni d'annulee, ne revient pas à prevue, et emise ou payee exige une date d'émission", () => {
    expect(migration).toContain('CREATE POLICY transitions_echeance ON "public"."echeances" AS RESTRICTIVE FOR UPDATE TO console_app');
    expect(migration).toContain(`USING (tenant_id IS NOT NULL AND statut IN ('prevue', 'emise')) WITH CHECK (tenant_id IS NOT NULL AND statut IN ('emise', 'payee', 'annulee'))`);
    expect(contraintes(echeances)).toContain("echeances_emission_datee");
    expect(migration).toContain(`CONSTRAINT "echeances_emission_datee" CHECK ("echeances"."statut" NOT IN ('emise', 'payee') OR "echeances"."date_emission" IS NOT NULL)`);
  });

  it("[A-125] @argent un acompte exige son taux, et un taux exige l'acompte", () => {
    expect(migration).toContain(`CONSTRAINT "abonnements_acompte_coherent" CHECK (("abonnements"."mode_avance" = 'acompte') = ("abonnements"."acompte_points_de_base" IS NOT NULL))`);
  });

  it("[A-146] la valeur d'une condition du client est un objet JSON", () => {
    expect(migration).toContain(`CONSTRAINT "conditions_commerciales_valeur_objet" CHECK (jsonb_typeof("conditions_commerciales"."valeur") = 'object')`);
  });

  it("[A-163] les clés étrangères entre ces tables sont composées (tenant_id, x) vers UNIQUE (tenant_id, id)", () => {
    for (const nom of ["plans_commerciaux_instance_fk", "phases_plan_plan_fk", "echeances_plan_fk", "abonnements_organisation_fk", "abonnements_conditions_fk", "conditions_commerciales_organisation_fk"]) {
      expect(migration, nom).toMatch(new RegExp(`CONSTRAINT "${nom}" FOREIGN KEY \\("tenant_id","[a-z_]+"\\) REFERENCES "public"\\."[a-z_]+"\\("tenant_id","id"\\)`));
    }
  });

  it("[A-163] la liste EXCEPTIONS_UNICITE reste vide après la migration de T2-04, aucune unicité sans tenant_id", () => {
    expect(EXCEPTIONS_UNICITE).toEqual([]);
    for (const t of [abonnements, plansCommerciaux, phasesPlan, echeances, conditionsCommerciales]) {
      for (const u of uniques(t)) expect(u[0], getTableConfig(t).name).toBe("tenant_id");
    }
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX/i);
  });
});
