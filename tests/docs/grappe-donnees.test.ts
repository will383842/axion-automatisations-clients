import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lireYaml } from "../../scripts/garde-compose.ts";

// T2-31 : preuve STATIQUE de la grappe « données » (ADR 0046), lue dans les fichiers livrés.
// Ces tests tournent dans le job couverture-req (sans conteneur). La preuve sur serveur réel est dans tests/donnees/grappe.int.test.ts (job socle-integration).
const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../../${chemin}`, import.meta.url)), "utf8");
const compose = () => lireYaml(lire("ops/socle/compose.donnees.yml")) as unknown as { services: Record<string, { networks?: string[]; ports?: string[] }>; volumes: Record<string, unknown> };

describe("grappe données, lecture des fichiers (A-050, A-199, A-167, C-477, C-497)", () => {
  it("[A-050] la grappe données a ses propres services, son volume, le réseau interne et aucun port publié", () => {
    const c = compose();
    expect(Object.keys(c.services)).toEqual(expect.arrayContaining(["donnees", "pgbouncer-donnees"]));
    expect(c.services["donnees"]?.networks).toEqual(["interne"]);
    expect(c.services["donnees"]?.ports).toBeUndefined();
    expect(Object.keys(c.volumes)).toContain("donnees-pgdata");
    const init = lire("ops/socle/donnees/init.sql");
    for (const base of ["console", "moteur", "keycloak", "passerelle_ia"]) expect(init).not.toMatch(new RegExp(`CREATE DATABASE ${base}\\b`, "i"));
  });

  it("[A-199] la recette crée une base par client, sans schéma par client ni règle de ligne commune", () => {
    const sql = lire("ops/socle/donnees/creer-base.sql");
    expect(sql).toMatch(/CREATE DATABASE :"base" TEMPLATE :"modele"/);
    expect(sql).not.toMatch(/CREATE SCHEMA/i);
    expect(sql).not.toMatch(/CREATE POLICY|ENABLE ROW LEVEL SECURITY/i);
  });

  it("[A-167] la recette crée trois rôles : propriétaire sans connexion, application et lecture sans propriété", () => {
    const sql = lire("ops/socle/donnees/creer-base.sql");
    expect(sql).toMatch(/CREATE ROLE :"proprio" NOLOGIN/);
    expect(sql).toMatch(/CREATE ROLE :"app" LOGIN/);
    expect(sql).toMatch(/CREATE ROLE :"lecture" LOGIN/);
    expect(sql).toMatch(/CREATE DATABASE :"base" TEMPLATE :"modele" OWNER :"proprio"/);
    expect(sql).not.toMatch(/OWNER :"(app|lecture)"/);
  });

  it("[C-477] la base client est fermée à PUBLIC et ouverte à ses seuls rôles", () => {
    const sql = lire("ops/socle/donnees/creer-base.sql");
    expect(sql).toMatch(/REVOKE ALL ON DATABASE :"base" FROM PUBLIC/);
    expect(sql).toMatch(/GRANT CONNECT ON DATABASE :"base" TO :"app", :"lecture", provisionneur/);
    expect(sql).toMatch(/REVOKE ALL ON SCHEMA public FROM PUBLIC/);
    expect(lire("ops/socle/donnees/init.sql")).toMatch(/REVOKE ALL ON DATABASE postgres, template0, template1, modele_v1 FROM PUBLIC/);
  });

  it("[C-497] la règle « une base par client, schéma par client au-delà de 5 000 seulement » est écrite dans l'ADR 0046", () => {
    const adr = lire("docs/adr/0046-bases-des-clients.md");
    expect(adr).toMatch(/Une base PAR client/);
    expect(adr).toMatch(/schéma par client/i);
    expect(adr).toMatch(/5 000 clients/);
    expect(adr).toMatch(/hors V1/);
    expect(adr).toMatch(/C-497/);
  });
});
