import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const lire = (chemin: string) => readFileSync(new URL(`../../../../${chemin}`, import.meta.url), "utf8");

describe("politiques et initialisation OpenBao du courtier", () => {
  it("[A-209] la politique donnees lit le secret app d'un client et jamais les autres genres ni le provisionneur", () => {
    const hcl = lire("ops/socle/openbao/donnees.hcl").replace(/^#.*$/gm, "");
    expect(hcl).toContain('path "technique/data/donnees/+/app"');
    expect(hcl).toContain('path "technique/metadata/donnees/+/app"');
    expect(hcl).toContain('path "technique/data/donnees/+/lecture"');
    expect(hcl).toContain('path "technique/metadata/donnees/+/lecture"');
    // Le joker * n'est valable qu'en dernier caractère d'un chemin OpenBao : un * au milieu ne couvre aucun secret.
    for (const m of hcl.matchAll(/path "([^"]*)"/g)) expect(m[1]!.slice(0, -1)).not.toContain("*");
    expect(hcl).not.toMatch(/proprietaire|provisionneur|pgbouncer-admin|technique\/data\/\*|technique\/data\/donnees\/\*|technique\/data\/donnees\/cli_/);
    for (const m of hcl.matchAll(/path "([^"]*)" \{\s*capabilities = \[([^\]]*)\]/g)) expect(m[2]).toBe('"read"');
    // courtier.hcl n'est pas touché : les tests C-012 et C-015 lui interdisent tout chemin technique/.
    expect(lire("ops/socle/openbao/politiques/courtier.hcl")).not.toMatch(/technique/);
  });

  it("[A-055] seuls api.hcl et donnees.hcl lisent technique/data/donnees/+/lecture ; aucun ne lit /proprietaire", () => {
    const dossier = new URL("../../../../ops/socle/openbao/", import.meta.url);
    const fichiers = [...readdirSync(fileURLToPath(new URL("politiques/", dossier))).filter((f) => f.endsWith(".hcl")).map((f) => `politiques/${f}`), ...readdirSync(fileURLToPath(dossier)).filter((f) => f.endsWith(".hcl"))];
    const couvre = (motif: string, cible: string) => new RegExp(`^${motif.replace(/[.?^${}()|[\]\\]/g, "\\$&").replace(/\+/g, "[^/]+").replace(/\*$/, ".*")}$`).test(cible);
    const lecteurs = (cible: string) => fichiers.filter((f) => [...readFileSync(new URL(f, dossier), "utf8").replace(/#.*$/gm, "").matchAll(/path\s+"([^"]+)"\s*\{([^}]*)\}/g)].some((m) => couvre(m[1]!, cible) && /"(read|sudo)"/.test(m[2]!))).map((f) => f.replace(/^politiques\//, "")).sort();
    expect(lecteurs("technique/data/donnees/cli_0123456789ab/lecture")).toEqual(["api.hcl", "donnees.hcl"]);
    expect(lecteurs("technique/data/donnees/cli_0123456789ab/app")).toEqual(["donnees.hcl"]);
    for (const interdit of ["technique/data/donnees/cli_0123456789ab/proprietaire", "technique/metadata/donnees/cli_0123456789ab/proprietaire", "technique/data/donnees/cli_0123456789ab/provisionneur", "technique/data/donnees/pgbouncer-admin"]) expect(lecteurs(interdit), interdit).toEqual([]);
    // donnees.hcl : lecture seule, et rien d'autre que app et lecture (données et métadonnées).
    const donnees = [...readFileSync(new URL("donnees.hcl", dossier), "utf8").replace(/#.*$/gm, "").matchAll(/path\s+"([^"]+)"\s*\{\s*capabilities\s*=\s*\[([^\]]*)\]/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(donnees.sort()).toEqual(['technique/data/donnees/+/app "read"', 'technique/data/donnees/+/lecture "read"', 'technique/metadata/donnees/+/app "read"', 'technique/metadata/donnees/+/lecture "read"']);
  });

  it("[A-209] le jeton de l'exécuteur (donnees) ne porte aucun droit sur le moteur database/ ni sur les baux : jetons séparés", () => {
    const hcl = lire("ops/socle/openbao/donnees.hcl").replace(/^#.*$/gm, "");
    expect(hcl).not.toMatch(/database\/|sys\/|humain/);
    expect(hcl).toContain('path "technique/data/donnees/+/app"');
  });

  it("[A-211] la politique humains lit les identifiants et révoque les baux des seuls rôles humain-lecture, avec son propre jeton", () => {
    const sh = lire("ops/socle/openbao/initialiser.sh");
    const m = /bao policy write humains - <<'POLITIQUE' >\/dev\/null\n([\s\S]*?)\nPOLITIQUE\n/.exec(sh);
    expect(m, "politique humains en ligne dans initialiser.sh").not.toBeNull();
    const hcl = m![1]!.replace(/^#.*$/gm, "");
    const chemins = [...hcl.matchAll(/path "([^"]*)" \{\s*capabilities = \[([^\]]*)\]/g)].map((x) => ({ chemin: x[1]!, droits: x[2]! }));
    expect(chemins).toEqual([
      { chemin: "database/creds/humain-lecture-cli_*", droits: '"read"' },
      { chemin: "sys/leases/revoke/database/creds/humain-lecture-cli_*", droits: '"update"' },
    ]);
    // Le joker n'est valable qu'en dernier caractère d'un chemin OpenBao.
    for (const { chemin } of chemins) expect(chemin.slice(0, -1)).not.toContain("*");
    expect(hcl).not.toMatch(/technique|clients|database\/(config|roles)|sudo|delete/);
    // Jeton à part (HUMAINS), distinct de DONNEES.
    expect(sh).toMatch(/token create -policy=humains /);
    expect(sh).toMatch(/printf 'HUMAINS=%s\\n'/);
  });

  it("[A-211] le moteur database/ relie la grappe données avec sslmode, sans rôle statique sans droit, rôles par client à 1 h", () => {
    const sh = lire("ops/socle/openbao/initialiser.sh");
    expect(sh).toMatch(/secrets enable database/);
    expect(sh).toMatch(/allowed_roles: "humain-lecture-cli_\*"/);
    expect(sh).toMatch(/connection_url: \("postgresql:\/\/\{\{username\}\}:\{\{password\}\}@" \+ env\.DONNEES_HOTE \+ ":5432\/postgres\?sslmode=(verify-full|require)"\)/);
    expect(sh).not.toMatch(/bao write database\/roles\/humain-lecture-cli /);
    expect(sh).not.toMatch(/INSERT|UPDATE|DELETE|SUPERUSER|CREATEROLE/);
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

  it("[A-211] l'inventaire nomme le jeton HUMAINS et l'ADR dit que RECONNECT ne coupe pas les sessions des clients", () => {
    expect(lire("ops/secrets-inventaire.md")).toMatch(/\| `HUMAINS` \| equipe \|[^\n]*accès humain/);
    const adr = lire("docs/adr/0046-bases-des-clients.md");
    expect(adr).toMatch(/`KILL` puis `RESUME`/);
    expect(adr).not.toMatch(/les coupe par la fiche T2-36b/);
  });
});
