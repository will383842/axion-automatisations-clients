import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { instances } from "./clients.ts";

// Contrôles sans base de données du schéma et de la migration 0018 ; les essais contre PostgreSQL sont dans db/executeur-instances.int.test.ts (socle-integration).
const migration = readFileSync(new URL("../../../drizzle/0018_executeur_instances.sql", import.meta.url), "utf8");
const config = getTableConfig(instances);
const colonne = (nom: string) => config.columns.find((c) => c.name === nom);

describe("instances → cellule et version de l'état voulu (migration 0018)", () => {
  it("[C-017] le schéma porte cellule_code (nul permis), arret_envois (faux par défaut) et version_etat_voulu (0 par défaut)", () => {
    expect(colonne("cellule_code")).toMatchObject({ notNull: false });
    expect(colonne("arret_envois")).toMatchObject({ notNull: true, default: false });
    expect(colonne("version_etat_voulu")).toMatchObject({ notNull: true, default: 0 });
    expect(config.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["instances_cellule_code_forme_c4", "instances_version_etat_voulu_positive"]));
    expect(config.foreignKeys.map((f) => f.getName())).toContain("instances_cellule_fk");
  });

  it("[C-017] la migration est additive : aucune destruction, aucun rattrapage, retour arrière documenté", () => {
    expect(migration).not.toMatch(/^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im);
    expect(migration).toMatch(/ADD COLUMN "cellule_code" text/);
    expect(migration).toMatch(/FOREIGN KEY \("cellule_code"\) REFERENCES "public"\."cellules"\("code"\) ON DELETE no action/);
    expect(migration).toMatch(/instances_cellule_code_forme_c4[\s\S]*char_length\("cellule_code"\) <= 64/);
    expect(migration).toMatch(/DROP TRIGGER[\s\S]*DROP FUNCTION/); // en commentaire seulement (vérifié par la ligne précédente)
  });

  it("[C-017] @isolation la fonction du déclencheur : search_path fixé, pas SECURITY DEFINER, révoquée à PUBLIC ; console_app lit les 3 colonnes", () => {
    expect(migration).toMatch(/CREATE FUNCTION public\.instances_version_etat_voulu\(\)[\s\S]*SET search_path = pg_catalog, pg_temp/);
    expect(migration).not.toMatch(/SECURITY DEFINER/i);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.instances_version_etat_voulu\(\) FROM PUBLIC/);
    expect(migration).toMatch(/CREATE TRIGGER instances_etat_voulu_version BEFORE UPDATE ON "public"\."instances"/);
    expect(migration).toMatch(/GRANT SELECT \("cellule_code", "arret_envois", "version_etat_voulu"\) ON TABLE "public"\."instances" TO console_app/);
    expect(migration).toMatch(/CREATE INDEX "instances_id_cellule_idx" ON "public"\."instances" USING btree \("id","cellule_code"\)/);
  });
});
