import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lire = (chemin: string) => readFileSync(new URL(`../../../../${chemin}`, import.meta.url), "utf8");

describe("politiques et initialisation OpenBao du courtier", () => {
  it("[A-209] la politique du courtier lit le secret app d'un client et jamais les autres genres ni le provisionneur", () => {
    const hcl = lire("ops/socle/openbao/politiques/courtier.hcl");
    expect(hcl).toContain('path "technique/data/donnees/cli_*/app"');
    expect(hcl).not.toMatch(/proprietaire|lecture"|provisionneur|pgbouncer-admin|technique\/data\/\*|technique\/data\/donnees\/cli_\*"/);
    for (const m of hcl.matchAll(/path "([^"]*)" \{\s*capabilities = \[([^\]]*)\]/g)) {
      if ((m[1] ?? "").startsWith("technique/") || (m[1] ?? "").startsWith("database/")) expect(m[2]).toBe('"read"');
    }
  });

  it("[A-211] le moteur database/ donne un rôle de lecture seule d'une heure, relié à la grappe données", () => {
    const sh = lire("ops/socle/openbao/initialiser.sh");
    expect(sh).toMatch(/secrets enable database/);
    expect(sh).toMatch(/humain-lecture-cli/);
    expect(sh).toMatch(/default_ttl=1h/);
    expect(sh).toMatch(/max_ttl=1h/);
    expect(sh).not.toMatch(/INSERT|UPDATE|DELETE|SUPERUSER|CREATEROLE/);
    const hcl = lire("ops/socle/openbao/donnees.hcl");
    expect(hcl).toContain('path "database/creds/humain-lecture-cli"');
    expect(hcl).not.toMatch(/"(create|update|delete|sudo)"/);
  });

  it("[A-169] l'inventaire des secrets nomme le compte de gestion et la rotation du courtier", () => {
    const inv = lire("ops/secrets-inventaire.md");
    expect(inv).toMatch(/technique\/donnees\/cli_<id>\/app[^\n]*30 jours/);
    expect(inv).toMatch(/gestion du moteur database/);
  });

  it("[A-169] l'ADR des bases des clients consigne le choix de rotation", () => {
    const adr = lire("docs/adr/0046-bases-des-clients.md");
    expect(adr).toMatch(/## Rotation des mots de passe \(T2-36\)/);
    expect(adr).toMatch(/VALID UNTIL/);
    expect(adr).toMatch(/_app_a/);
  });
});
