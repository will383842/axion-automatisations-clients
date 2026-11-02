import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { EXCEPTIONS_UNICITE, controlerInvariants, type Requete } from "../../../../../packages/contrats/src/c5/invariants.ts";
import { TABLES_CLIENT } from "./aides.ts";
import { apporteursClients, contrats, devis, factures, natureFacture, statutDevis, typeContrat } from "./contrats.ts";

// Contrôles sans base de données du schéma et de la migration 0009 ; les essais contre PostgreSQL sont dans db/contrats.int.test.ts (job socle-integration).
const migration = readFileSync(new URL("../../../drizzle/0009_contrats.sql", import.meta.url), "utf8");
type Table = Parameters<typeof getTableConfig>[0];
const colonnes = (t: Table) => getTableConfig(t).columns.map((c) => c.name);
const uniques = (t: Table) => getTableConfig(t).uniqueConstraints.map((u) => u.columns.map((c) => c.name));
const droits = (table: string) => [...migration.matchAll(new RegExp(`GRANT ([A-Z, ]+(?:\\([^)]*\\))?) ON TABLE "public"\\."${table}" TO console_app`, "g"))].map((m) => m[1]);
const TABLES = ["contrats", "devis", "factures", "apporteurs_clients"];

describe("contrats, devis, factures, apporteurs : schéma et migration 0009", () => {
  it("[A-035] la fiche client garde la date de signature et la référence du PDF du contrat", () => {
    expect(colonnes(contrats)).toEqual(expect.arrayContaining(["tenant_id", "organisation_id", "type", "date_signature", "pdf_ref"]));
    // Jamais le PDF en base : une référence d'objet du stockage, bornée et sans base64.
    expect(colonnes(contrats)).not.toContain("pdf");
    expect(migration).toMatch(/CHECK \("contrats"\."pdf_ref" ~ '/);
  });

  it("[A-155] le contrat de sous-traitance est rangé dans la fiche client avec son empreinte", () => {
    expect(typeContrat.enumValues).toContain("sous_traitance_art28");
    expect(colonnes(contrats)).toContain("empreinte_sha256");
    expect(migration).toContain(`CHECK ("contrats"."empreinte_sha256" ~ '^[0-9a-f]{64}$')`);
    // Un contrat signé ne change plus et ne s'efface pas : lecture, ajout, et la seule révocation (deux colonnes).
    expect(droits("contrats").join()).toBe('SELECT, INSERT,UPDATE ("revoque_le", "revoque_par")');
  });

  it("[A-148] un contrat refuse un type hors énumération", () => {
    expect(typeContrat.enumValues).toEqual(["contrat_service", "sous_traitance_art28", "bon_de_commande", "autre"]);
    expect(migration).toContain(`CREATE TYPE "public"."type_contrat" AS ENUM('contrat_service', 'sous_traitance_art28', 'bon_de_commande', 'autre')`);
  });

  it("[A-154] un devis refuse un statut hors brouillon, envoye, accepte, refuse, expire (et annule, par le seul fait devis.annule)", () => {
    expect(statutDevis.enumValues).toEqual(["brouillon", "envoye", "accepte", "refuse", "expire", "annule"]);
    expect(colonnes(devis)).toEqual(expect.arrayContaining(["numero_hub", "proposition_ref", "pdf_ref", "date_envoi", "duree_validite_jours", "statut", "motif_annulation", "annule_le", "annule_par"]));
    expect(migration).toContain(`CREATE TYPE "public"."statut_devis" AS ENUM('brouillon', 'envoye', 'accepte', 'refuse', 'expire', 'annule')`);
    expect(migration).toMatch(/CONSTRAINT "devis_annulation_complete" CHECK/);
  });

  it("[A-133] @argent deux factures d'abonnement pour la même période sont refusées ; un avoir passe (index partiel sur la nature abonnement)", () => {
    expect(natureFacture.enumValues).toEqual(["abonnement", "mise_en_place", "complement_prorata", "avoir"]);
    expect(colonnes(factures)).toEqual(expect.arrayContaining(["numero", "hub_id", "nature", "plan", "periode_debut", "periode_fin", "montant_ht_centimes", "statut", "pdf_ref", "empreinte_sha256"]));
    expect(migration).toContain(`CREATE UNIQUE INDEX "factures_abonnement_periode_unique" ON "factures" USING btree ("tenant_id","plan","periode_debut") WHERE "factures"."nature" = 'abonnement' AND "factures"."statut" <> 'annulee'`);
  });

  it("[A-133] @argent une seconde facture de mise en place pour la même automatisation est refusée", () => {
    expect(migration).toContain(`CREATE UNIQUE INDEX "factures_mise_en_place_unique" ON "factures" USING btree ("tenant_id","code_automatisation") WHERE "factures"."nature" = 'mise_en_place' AND "factures"."statut" <> 'annulee'`);
  });

  it("[A-133] @argent la console ne corrige jamais une facture : seul le statut est modifiable, ni montant, ni numéro, ni PDF", () => {
    expect(droits("factures").join()).toBe('SELECT, INSERT,UPDATE ("statut", "auteur")');
    expect(droits("devis").join()).toMatch(/^SELECT, INSERT,UPDATE \("statut"/);
    expect(migration).not.toMatch(/GRANT UPDATE[^;]*(montant_ht_centimes|numero|pdf_ref)/);
    expect(migration).toContain(`"factures"."montant_ht_centimes" BETWEEN 0 AND 9007199254740991`);
  });

  it("[A-147] la table des apporteurs garde l'identifiant axion-ia, le taux en points de base et la date de lecture, sans écriture par console_app", () => {
    expect(colonnes(apporteursClients)).toEqual(expect.arrayContaining(["organisation_id", "apporteur_axion_ia_id", "taux_points_de_base", "commissions_dues_centimes", "lu_le"]));
    expect(migration).toMatch(/CHECK \("apporteurs_clients"\."taux_points_de_base" BETWEEN 0 AND 10000\)/);
    expect(droits("apporteurs_clients").join()).toBe("SELECT");
  });

  it("[A-119] chaque table a ENABLE, FORCE, ses deux politiques, un index sur tenant_id, le journal d'audit et aucun DELETE ni TRUNCATE", () => {
    expect(TABLES_CLIENT.map((t) => t.nom)).toEqual(expect.arrayContaining(TABLES));
    for (const t of TABLES) {
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" ENABLE ROW LEVEL SECURITY`);
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" FORCE ROW LEVEL SECURITY`);
      expect(migration, t).toContain(`CREATE POLICY isolation_client ON "public"."${t}" FOR ALL TO console_app`);
      expect(migration, t).toContain(`CREATE POLICY lecture_equipe ON "public"."${t}" FOR SELECT TO console_equipe`);
      expect(migration, t).toContain(`CREATE INDEX "${t}_tenant_id_idx" ON "${t}" USING btree ("tenant_id")`);
      expect(migration, t).toContain(`CREATE TRIGGER ${t}_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."${t}"`);
      expect(droits(t).join(), t).not.toMatch(/DELETE|TRUNCATE/);
    }
    expect(migration).not.toMatch(/portail_app|TO PUBLIC/i);
  });

  it("[A-163] @isolation les index partiels d'abonnement et de mise en place portent tenant_id, comme les numéros de devis et de facture", () => {
    expect(uniques(devis)).toContainEqual(["tenant_id", "numero_hub"]);
    expect(uniques(factures)).toContainEqual(["tenant_id", "numero"]);
    for (const m of migration.matchAll(/CREATE UNIQUE INDEX "[a-z_]+" ON "[a-z_]+" USING btree \(([^)]*)\)/g)) expect(m[1]).toMatch(/^"tenant_id",/);
    expect(migration).not.toMatch(/UNIQUE\s*\(\s*"(numero|numero_hub)"\s*\)/i);
  });

  it("[A-163] la liste EXCEPTIONS_UNICITE reste vide après la migration de T2-05", () => {
    expect(EXCEPTIONS_UNICITE).toEqual([]);
  });

  it("[C-030] une clé étrangère de T2-05 est composée (tenant_id, x) vers UNIQUE (tenant_id, id)", () => {
    for (const m of migration.matchAll(/ADD CONSTRAINT "[a-z_]+" FOREIGN KEY \(([^)]*)\) REFERENCES/g)) expect(m[1]).toMatch(/^"tenant_id",/);
    expect(migration).toContain(`FOREIGN KEY ("tenant_id","facture_id") REFERENCES "public"."factures"("tenant_id","id")`);
  });
});

// Schéma d'essai : un faux PostgreSQL qui répond au contrôle C5 avec les index de T2-05 ou avec les mêmes index sans tenant_id.
type Unique = { oid: number; index: string; primaire: boolean; porte_tenant: boolean; identite_generee: boolean };
function faux(uniquesDe: Unique[]): Requete {
  return async (sql) => {
    if (sql.includes("indisunique")) return uniquesDe as Record<string, unknown>[];
    if (sql.includes("contype = 'f'")) return [];
    if (sql.includes("FROM pg_class c")) return [1, 2].map((oid) => ({ oid, schema: "public", nom: oid === 1 ? "devis" : "factures", rls: true, force_rls: true, proprietaire: "migration", membres: ["migration"] }));
    if (sql.includes("information_schema.columns")) return ["devis", "factures"].map((t) => ({ schema: "public", table: t, colonne: "tenant_id", type: "uuid", nullable: "NO" }));
    if (sql.includes("pg_policies")) return ["devis", "factures"].map((t) => ({ schema: "public", table: t, permissive: "PERMISSIVE", cmd: "ALL", qual: "(tenant_id = current_setting('app.tenant_id')::uuid)", with_check: null }));
    if (sql.includes("i.indisvalid")) return [{ oid: 1 }, { oid: 2 }];
    return [];
  };
}
describe("unicité des numéros : règle unicite_sans_tenant (ADR 0040)", () => {
  const OPTIONS = { rolesApplication: /^app(_|$)/ };
  const signales = async (u: Unique[]) => (await controlerInvariants(faux(u), "console", OPTIONS as never)).filter((e) => e.regle === "unicite_sans_tenant").map((e) => e.objet);
  it("[A-163] @isolation un index unique sur devis.numero_hub ou factures.numero sans tenant_id est signalé par unicite_sans_tenant (schéma d'essai) ; les index réels (tenant_id, numero) ne le sont pas", async () => {
    const sans = (oid: number, index: string): Unique => ({ oid, index, primaire: false, porte_tenant: false, identite_generee: false });
    expect(await signales([sans(1, "devis_numero_hub_key"), sans(2, "factures_numero_key")])).toEqual(["devis.devis_numero_hub_key", "factures.factures_numero_key"]);
    const avec = (oid: number, index: string): Unique => ({ ...sans(oid, index), porte_tenant: true });
    expect(await signales([avec(1, "devis_tenant_id_numero_hub_unique"), avec(2, "factures_tenant_id_numero_unique")])).toEqual([]);
    expect(migration).toContain(`CONSTRAINT "devis_tenant_id_numero_hub_unique" UNIQUE("tenant_id","numero_hub")`);
    expect(migration).toContain(`CONSTRAINT "factures_tenant_id_numero_unique" UNIQUE("tenant_id","numero")`);
  });
});
