import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { TABLES_COMMUNES, TENANT_FACULTATIF } from "../../../../../packages/contrats/src/c5/invariants.ts";
import { TABLES_CLIENT } from "./aides.ts";
import { aTrancher, boiteEnvoi, destinationEnvoi, etatATrancher, etatEnvoi, exclusions, exclusionsPlateforme, faitsRecus, liensCrm, motifATrancher, motifExclusion } from "./canaux.ts";

// Contrôles sans base de données du schéma et de la migration 0006 ; les essais contre PostgreSQL sont dans db/canaux.int.test.ts (job socle-integration).
const migration = readFileSync(new URL("../../../drizzle/0006_canaux.sql", import.meta.url), "utf8");
type Table = Parameters<typeof getTableConfig>[0];
const colonnes = (t: Table) => getTableConfig(t).columns.map((c) => c.name);
const contraintes = (t: Table) => getTableConfig(t).checks.map((c) => c.name);
const uniques = (t: Table) => getTableConfig(t).uniqueConstraints.map((u) => u.columns.map((c) => c.name));
const droits = (table: string) => [...migration.matchAll(new RegExp(`GRANT ([A-Z, ]+(?:\\([^)]*\\))?) ON TABLE "public"\\."${table}" TO console_app`, "g"))].map((m) => m[1]);
const TABLES = ["boite_envoi", "faits_recus", "liens_crm", "a_trancher", "exclusions"];

describe("tables des canaux : schéma et migration 0006", () => {
  it("[C-402] une ligne de boîte d'envoi porte sa destination, sa route, sa méthode, son corps, sa clé, son empreinte et son état a_envoyer par défaut", () => {
    expect(colonnes(boiteEnvoi)).toEqual(expect.arrayContaining(["tenant_id", "destination", "route", "methode", "corps", "cle_anti_doublon", "empreinte_corps", "etat", "nombre_essais", "prochain_essai", "derniere_erreur", "reponse_recue", "cree_le"]));
    expect(destinationEnvoi.enumValues).toEqual(["hub", "crm"]);
    expect(etatEnvoi.enumValues).toEqual(["a_envoyer", "en_cours", "envoye", "echec"]);
    expect(getTableConfig(boiteEnvoi).columns.find((c) => c.name === "etat")?.default).toBe("a_envoyer");
  });

  it("[C-535] la clé anti-doublon est unique PAR CLIENT dans la boîte d'envoi, jamais seule", () => {
    expect(uniques(boiteEnvoi)).toContainEqual(["tenant_id", "cle_anti_doublon"]);
    expect(migration).toContain('CONSTRAINT "boite_envoi_tenant_id_cle_anti_doublon_unique" UNIQUE("tenant_id","cle_anti_doublon")');
    expect(migration).not.toMatch(/UNIQUE\s*\(\s*"cle_anti_doublon"\s*\)|UNIQUE INDEX[^;]*\("cle_anti_doublon"\)/i);
  });

  it("[C-402] l'event_id d'un fait reçu est unique par (client, source), les tables de la file portent leur colonne sequence", () => {
    expect(colonnes(faitsRecus)).toEqual(expect.arrayContaining(["source", "event_id", "type", "sequence", "sujet", "recu_le", "traite_le", "resultat"]));
    expect(uniques(faitsRecus)).toContainEqual(["tenant_id", "source", "event_id"]);
    expect(migration).not.toMatch(/UNIQUE\s*\(\s*"event_id"\s*\)|UNIQUE INDEX[^;]*\("event_id"\)/i);
  });

  it("[C-402] le lien CRM est unique par (client, crm_company_id) et garde son état et l'absorbante", () => {
    expect(colonnes(liensCrm)).toEqual(expect.arrayContaining(["organisation_id", "crm_company_id", "etat", "absorbe_par"]));
    expect(uniques(liensCrm)).toContainEqual(["tenant_id", "crm_company_id"]);
  });

  it("[C-456] la file « à trancher » a les cinq motifs, deux états, et ne se ferme qu'avec une décision et son auteur", () => {
    expect(motifATrancher.enumValues).toEqual(["siren_absent_ressemblance", "ressaisie_manuelle", "email_change", "fiche_absorbee", "incoherence_nuit"]);
    expect(etatATrancher.enumValues).toEqual(["ouvert", "tranche"]);
    expect(colonnes(aTrancher)).toEqual(expect.arrayContaining(["organisation_id", "source", "motif", "donnees_comparaison", "etat", "tranche_par", "decision"]));
    expect(contraintes(aTrancher)).toContain("a_trancher_cloture");
    expect(migration).toMatch(/"a_trancher_cloture" CHECK/);
  });

  it("[C-083] l'exclusion du client garde une empreinte SHA-256 en hexadécimal (64 caractères), jamais l'e-mail", () => {
    expect(colonnes(exclusions)).toEqual(expect.arrayContaining(["portee", "empreinte_email", "motif", "source", "cree_le"]));
    expect(colonnes(exclusions)).not.toContain("email");
    expect(contraintes(exclusions)).toContain("exclusions_empreinte_format");
    expect(migration).toContain(`CHECK ("exclusions"."empreinte_email" ~ '^[0-9a-f]{64}$')`);
    expect(uniques(exclusions)).toContainEqual(["tenant_id", "empreinte_email"]);
  });

  it("[C-504] la liste commune n'accepte que rebond et plainte (CHECK), et son empreinte est elle aussi hexadécimale", () => {
    expect(motifExclusion.enumValues).toEqual(expect.arrayContaining(["rebond", "plainte"]));
    expect(contraintes(exclusionsPlateforme)).toEqual(expect.arrayContaining(["exclusions_plateforme_motif_commun", "exclusions_plateforme_empreinte_format"]));
    expect(migration).toContain(`CHECK ("exclusions_plateforme"."motif" IN ('rebond', 'plainte'))`);
  });

  it("[C-633] deux portées : l'exclusion du client reste de portée client, la portée plateforme vit dans une table sans tenant_id", () => {
    expect(getTableConfig(exclusions).columns.find((c) => c.name === "portee")?.default).toBe("client");
    expect(colonnes(exclusionsPlateforme)).not.toContain("tenant_id");
    expect(TABLES_COMMUNES).toEqual(["public.exclusions_plateforme"]);
    expect(TENANT_FACULTATIF).toEqual(["public.journal_audit"]);
    expect(Object.isFrozen(TABLES_COMMUNES)).toBe(true);
    // Lecture par console_app, écriture par console_equipe seul ; aucun droit de suppression.
    expect(migration).toContain('GRANT SELECT ON TABLE "public"."exclusions_plateforme" TO console_app');
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE "public"."exclusions_plateforme" TO console_equipe');
    expect(migration).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*"exclusions_plateforme" TO console_app/);
  });

  it("[A-119] chaque table des canaux a ENABLE, FORCE, ses deux politiques, un index sur tenant_id et aucun DELETE ni TRUNCATE", () => {
    expect(TABLES_CLIENT.map((t) => t.nom)).toEqual(expect.arrayContaining(TABLES));
    for (const t of TABLES) {
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" ENABLE ROW LEVEL SECURITY`);
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" FORCE ROW LEVEL SECURITY`);
      expect(migration, t).toContain(`CREATE POLICY isolation_client ON "public"."${t}" FOR ALL TO console_app`);
      expect(migration, t).toContain(`CREATE POLICY lecture_equipe ON "public"."${t}" FOR SELECT TO console_equipe`);
      expect(migration, t).toContain(`CREATE INDEX "${t}_tenant_id_idx" ON "${t}" USING btree ("tenant_id")`);
      expect(droits(t).join(), t).not.toMatch(/DELETE|TRUNCATE/);
    }
    expect(migration).toContain('ALTER TABLE "public"."exclusions_plateforme" FORCE ROW LEVEL SECURITY');
    expect(migration).not.toMatch(/portail_app|TO PUBLIC/i);
    expect(migration).not.toMatch(/GRANT[^;]*\b(TRUNCATE|REFERENCES|TRIGGER|ALL|DELETE)\b[^;]*TO console_(app|equipe)/i);
  });

  it("[C-535] la boîte d'envoi ne laisse modifier que son état, ses essais, son erreur et sa réponse : ni la clé ni le corps", () => {
    expect(droits("boite_envoi").join()).toBe('SELECT, INSERT,UPDATE ("etat", "nombre_essais", "prochain_essai", "derniere_erreur", "reponse_recue")');
    expect(migration).not.toMatch(/GRANT UPDATE[^;]*cle_anti_doublon/);
  });
});
