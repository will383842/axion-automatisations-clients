import { readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { chiffrerSortie, dechiffrerSortie, validerSortie, type Chiffreur } from "./chiffrer-sortie.ts";
import { curseurs, executions, intentions, journalEtape } from "./schema.ts";

// Contrôles sans base de données du schéma et de la migration moteur 0000 ; les essais contre PostgreSQL sont dans moteur.int.test.ts (job socle-integration).
const migration = readFileSync(new URL("../../drizzle/0000_etat_technique.sql", import.meta.url), "utf8");
const init = readFileSync(new URL("../../../../ops/socle/postgres/init/06-moteur-purge.sql", import.meta.url), "utf8");
type Table = Parameters<typeof getTableConfig>[0];
const TABLES = [executions, journalEtape, intentions, curseurs] as Table[];
const NOMS = ["executions", "journal_etape", "intentions", "curseurs"];
const colonnes = (t: Table) => getTableConfig(t).columns.map((c) => c.name);

// Chiffreur de test : une clé AES par client, le client lié au chiffré (même principe que enveloppe.ts).
function chiffreurFactice(): Chiffreur {
  const cles = new Map<string, Buffer>();
  const cle = (t: string) => cles.get(t) ?? (cles.set(t, randomBytes(32)), cles.get(t) as Buffer);
  return {
    async chiffrer(tenantId, octets) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", cle(tenantId), iv);
      c.setAAD(Buffer.from(tenantId));
      return { chiffre: Buffer.concat([iv, c.update(octets), c.final(), c.getAuthTag()]), cleChiffree: "vault:v1:AAAA", version: 1 };
    },
    async dechiffrer(tenantId, e) {
      const d = createDecipheriv("aes-256-gcm", cle(tenantId), e.chiffre.subarray(0, 12));
      d.setAAD(Buffer.from(tenantId));
      d.setAuthTag(e.chiffre.subarray(e.chiffre.length - 16));
      return Buffer.concat([d.update(e.chiffre.subarray(12, e.chiffre.length - 16)), d.final()]);
    },
  };
}
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("base moteur : schéma et migration 0000", () => {
  it("[A-053] @isolation chaque table de moteur a tenant_id NOT NULL, une RLS forcée et un index qui commence par tenant_id", () => {
    for (const [i, t] of TABLES.entries()) {
      const nom = NOMS[i] as string;
      expect(colonnes(t)[0], nom).toBe("tenant_id");
      expect(getTableConfig(t).columns[0]?.notNull, nom).toBe(true);
      expect(migration, nom).toMatch(new RegExp(`CREATE TABLE "${nom}" \\(\\s*"tenant_id" uuid NOT NULL`));
      expect(migration, nom).toContain(`ALTER TABLE "public"."${nom}" ENABLE ROW LEVEL SECURITY`);
      expect(migration, nom).toContain(`ALTER TABLE "public"."${nom}" FORCE ROW LEVEL SECURITY`);
      expect(migration, nom).toContain(`CREATE INDEX "${nom}_tenant_id_idx" ON "${nom}" USING btree ("tenant_id")`);
    }
    expect(migration).toMatch(/PARTITION BY RANGE \("debut"\)/);
    expect(migration).toContain("partman.create_parent");
    expect(migration).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE|ALL)\b[^;]*TO moteur_app/i);
    expect(migration).not.toMatch(/TO PUBLIC|portail_app/i);
  });

  it("[A-312] @isolation la politique de moteur_app est restrictive, cite tenant_id et n'a aucun repli « systeme »", () => {
    for (const nom of NOMS) {
      expect(migration, nom).toContain(`CREATE POLICY isolation_client ON "public"."${nom}" FOR ALL TO moteur_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`);
      expect(migration, nom).toContain(`CREATE POLICY garde_client ON "public"."${nom}" AS RESTRICTIVE FOR ALL TO moteur_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`);
    }
    expect(migration).not.toMatch(/systeme|IS NULL OR tenant_id|USING \(true\)/i);
  });

  it("[A-372] une exécution porte son instance, ses étiquettes client et automatisation, son début, sa fin et son issue", () => {
    expect(colonnes(executions)).toEqual(expect.arrayContaining(["tenant_id", "id", "instance_id", "automatisation", "debut", "fin", "issue"]));
    expect(getTableConfig(executions).primaryKeys[0]?.columns.map((c) => c.name)).toEqual(["tenant_id", "id", "debut"]);
  });

  it("[A-312] une insertion directe en état final est refusée : exécution sans fin, étape en cours, intention écrite", () => {
    expect(migration).toContain(`CREATE POLICY depart_execution ON "public"."executions" AS RESTRICTIVE FOR INSERT TO moteur_app WITH CHECK ("fin" IS NULL AND "issue" IS NULL)`);
    expect(migration).toContain(`CREATE POLICY depart_etape ON "public"."journal_etape" AS RESTRICTIVE FOR INSERT TO moteur_app WITH CHECK ("statut" = 'en_cours')`);
    expect(migration).toContain(`CREATE POLICY depart_intention ON "public"."intentions" AS RESTRICTIVE FOR INSERT TO moteur_app WITH CHECK ("etat" = 'ecrite')`);
    expect(getTableConfig(intentions).uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toContainEqual(["tenant_id", "cle_intention"]);
  });

  it("[C-022] le schéma de sortie refuse un champ texte libre, un tableau, un objet imbriqué et un code trop long", () => {
    expect(validerSortie({ contact_id: "5b0c1f2e-7d3a-4c1b-9a55-0d6f3b1e2a10", code: "envoye", nombre: 3 })).toEqual({ contact_id: "5b0c1f2e-7d3a-4c1b-9a55-0d6f3b1e2a10", code: "envoye", nombre: 3 });
    expect(() => validerSortie({ message: "Bonjour Madame, voici votre devis pour la cuisine" })).toThrow();
    expect(() => validerSortie({ code: "x".repeat(65) })).toThrow();
    expect(() => validerSortie({ codes: ["a", "b"] })).toThrow();
    expect(() => validerSortie({ a: { b: "c" } })).toThrow();
    expect(() => validerSortie({ "Nom du client": "ok" })).toThrow();
    expect(() => validerSortie("texte")).toThrow();
  });

  it("[A-313] la sortie relue en base est chiffrée et ne se déchiffre qu'avec la clé du même client", async () => {
    const chiffreur = chiffreurFactice();
    const sortie = { contact_id: "5b0c1f2e-7d3a-4c1b-9a55-0d6f3b1e2a10", code: "envoye" };
    const ligne = await chiffrerSortie(chiffreur, A, sortie);
    expect(Buffer.isBuffer(ligne.sortieChiffree)).toBe(true);
    expect(ligne.sortieChiffree.toString("utf8")).not.toContain("envoye");
    expect(ligne.sortieChiffree.toString("latin1")).not.toContain("5b0c1f2e");
    expect(await dechiffrerSortie(chiffreur, A, ligne)).toEqual(sortie);
    await expect(dechiffrerSortie(chiffreur, B, ligne)).rejects.toThrow();
    await expect(chiffrerSortie(chiffreur, A, { message: "texte libre avec des espaces" })).rejects.toThrow();
  });

  it("[C-021] la migration double la purge de politiques RESTRICTIVE en DELETE : exécution terminée, intention faite", () => {
    expect(migration).toContain('CREATE POLICY purge_garde_execution ON "public"."executions" AS RESTRICTIVE FOR DELETE TO moteur_purge USING ("fin" IS NOT NULL)');
    expect(migration).toContain('CREATE POLICY purge_garde_intention ON "public"."intentions" AS RESTRICTIVE FOR DELETE TO moteur_purge USING ("etat" = \'faite\')');
  });

  it("[C-415] moteur_purge n'a de droit de connexion que sur moteur : aucune base console ni cli_<id>", () => {
    expect(init).toMatch(/CREATE ROLE moteur_purge LOGIN NOBYPASSRLS NOINHERIT/);
    expect([...init.matchAll(/GRANT CONNECT ON DATABASE (\w+)/g)].map((m) => m[1])).toEqual(["moteur"]);
    expect(init).not.toMatch(/console|cli_|keycloak|passerelle/i);
    expect(migration).toContain('GRANT SELECT, DELETE ON TABLE "public"."executions" TO moteur_purge');
    expect(migration).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|TRUNCATE)[^;]*TO moteur_purge/);
  });
});
