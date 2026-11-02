import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Dette T2-34 n° 6 (propriétaire T2-35) : le provisionneur lit le secret pgbouncer-admin pour recharger PgBouncer ; admin_users ne doit donc plus être vide.
const INI = readFileSync(new URL("../../../../ops/socle/donnees/pgbouncer.ini", import.meta.url), "utf8");
const valeur = (cle: string) => INI.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`${cle} =`))?.slice(cle.length + 2).trim();

describe("administration de PgBouncer par le provisionneur", () => {
  it("[A-220] admin_users nomme un seul utilisateur d'administration, qui n'est ni un rôle de client ni celui de la recherche des mots de passe", () => {
    const admin = valeur("admin_users");
    expect(admin).toBe("pgbouncer_admin");
    expect(admin).not.toBe(valeur("auth_user"));
    expect(admin).not.toMatch(/^cli_/);
    expect(valeur("stats_users")).toBe("");
  });
});
