import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const racine = join(__dirname, "..");
function sources(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) return sources(chemin);
    return /\.ts$/.test(nom) && !/\.test\.ts$/.test(nom) ? [chemin] : [];
  });
}

describe("ALTER ROLE du provisionnement", () => {
  it("[A-219] aucun ALTER ROLE ne cite SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE ni REPLICATION (refusé par PostgreSQL 16 au provisionneur)", () => {
    const fautifs: string[] = [];
    for (const f of sources(racine)) {
      for (const ligne of readFileSync(f, "utf8").split("\n")) {
        if (/^\s*\/\//.test(ligne)) continue;
        if (/ALTER ROLE/i.test(ligne) && /\b(NO)?(SUPERUSER|BYPASSRLS|CREATEDB|CREATEROLE|REPLICATION)\b/i.test(ligne)) fautifs.push(`${f}: ${ligne.trim()}`);
      }
    }
    expect(fautifs).toEqual([]);
  });
});
