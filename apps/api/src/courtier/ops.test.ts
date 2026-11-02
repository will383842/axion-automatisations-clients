import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lire = (chemin: string) => readFileSync(new URL(`../../../../${chemin}`, import.meta.url), "utf8");

describe("politiques et initialisation OpenBao du courtier", () => {
  it("[A-209] la politique donnees lit le secret app d'un client et jamais les autres genres ni le provisionneur", () => {
    const hcl = lire("ops/socle/openbao/donnees.hcl").replace(/^#.*$/gm, "");
    expect(hcl).toContain('path "technique/data/donnees/+/app"');
    expect(hcl).toContain('path "technique/metadata/donnees/+/app"');
    // Le joker * n'est valable qu'en dernier caractère d'un chemin OpenBao : un * au milieu ne couvre aucun secret.
    for (const m of hcl.matchAll(/path "([^"]*)"/g)) expect(m[1]!.slice(0, -1)).not.toContain("*");
    expect(hcl).not.toMatch(/proprietaire|provisionneur|pgbouncer-admin|technique\/data\/\*|technique\/data\/donnees\/\*|technique\/data\/donnees\/cli_/);
    for (const m of hcl.matchAll(/path "([^"]*)" \{\s*capabilities = \[([^\]]*)\]/g)) expect(m[2]).toBe('"read"');
    // courtier.hcl n'est pas touché : les tests C-012 et C-015 lui interdisent tout chemin technique/.
    expect(lire("ops/socle/openbao/politiques/courtier.hcl")).not.toMatch(/technique/);
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
    expect(hcl).not.toMatch(/database\/(config|roles)/);
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
