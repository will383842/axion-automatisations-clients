import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../drizzle/0010_exploitation.sql", import.meta.url), "utf8");

describe("réglage de pg_partman pour la rétention", () => {
  it("[A-180] la migration ne pose aucune rétention dans part_config : le retrait passe par le code, avec interrupteur et gel", () => {
    expect(migration).not.toMatch(/part_config[^;]*\bretention\b/i);
    expect(migration).not.toMatch(/p_retention|retention_keep/i);
    expect(migration).not.toMatch(/UPDATE\s+partman\.part_config/i);
  });
});
