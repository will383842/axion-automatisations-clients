import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../ops/verifier-reglages-depot.sh", import.meta.url));

// Faux « gh » : l'appel à /installation échoue (401 réel), le reste répond comme un dépôt bien réglé.
function lancer(installation: "echec" | "read" | "write", reglages: { approbation?: string; dependabot?: string; fusionAuto?: string; sansGardeFusion?: boolean; workflows?: string; env?: Record<string, string> } = {}) {
  const dossier = mkdtempSync(join(tmpdir(), "faux-gh-"));
  const gh = join(dossier, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
case "$*" in
  */installation*) ${installation === "echec" ? "exit 1" : `echo ${installation}`} ;;
  *required_status_checks*) printf '%s\\n' "Aucun secret dans le dépôt (Gitleaks)" types lint tests garde-workflows compter-tests licences couverture-req ${reglages.sansGardeFusion ? "garde-noms" : "garde-fusion"} garde-couleurs harnais contrats-pg visuel-design ;;
  *allow_auto_merge*) echo ${reglages.fusionAuto ?? "false"} ;;
  *fork-pr-contributor-approval*) echo ${reglages.approbation ?? "all_external_contributors"} ;;
  *actions/permissions/workflow*) echo read ;;
  *private-vulnerability-reporting*) echo true ;;
  *has_issues*) echo false ;;
  *security_and_analysis*) echo '{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"},"dependabot_security_updates":{"status":"${reglages.dependabot ?? "enabled"}"}}' ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  return spawnSync("bash", [script, "proprio/depot", ...(reglages.workflows ? [reglages.workflows] : [])], { encoding: "utf8", env: { ...process.env, ...reglages.env, PATH: `${dossier}:${process.env.PATH ?? ""}` } });
}

describe("ops/verifier-reglages-depot.sh", () => {
  it("[C-529] échoue avec un message clair quand les droits de l'application ne sont pas vérifiables", () => {
    const r = lancer("echec");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/À CORRIGER.*statuses/);
    expect(r.stdout).not.toMatch(/OK\s+l'application Claude/);
  });
  it("[C-529] échoue quand l'application peut écrire les statuts", () => {
    const r = lancer("write");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/À CORRIGER.*statuses/);
  });
  it("[C-529] réussit quand tout est vérifié et conforme", () => {
    const r = lancer("read");
    expect(r.stdout).not.toContain("À CORRIGER");
    expect(r.status).toBe(0);
  });
  it("[C-529] refuse une politique d'approbation plus faible dont le nom contient une politique valide", () => {
    const r = lancer("read", { approbation: "first_time_contributors_new_to_github" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/À CORRIGER.*contributeurs extérieurs/);
  });
  it("[C-529] échoue quand les mises à jour de sécurité de Dependabot sont désactivées", () => {
    const r = lancer("read", { dependabot: "disabled" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/À CORRIGER.*Dependabot/);
  });
  it("[C-611] verifier-reglages-depot.sh exige garde-fusion et refuse la fusion automatique", () => {
    const sans = lancer("read", { sansGardeFusion: true });
    expect(sans.status).not.toBe(0);
    expect(sans.stdout).toMatch(/À CORRIGER.*garde-fusion/);
    const auto = lancer("read", { fusionAuto: "true" });
    expect(auto.status).not.toBe(0);
    expect(auto.stdout).toMatch(/À CORRIGER.*fusion automatique/);
    const bon = lancer("read");
    expect(bon.stdout).toMatch(/OK\s+main exige le contrôle « garde-fusion »/);
    expect(bon.stdout).toMatch(/OK\s+fusion automatique désactivée/);
    expect(bon.stdout).not.toMatch(/garde-noms/);
  });
  it("[C-529] verifier-reglages-depot.sh refuse un workflow qui demande statuses: write ou checks: write", () => {
    const dossier = mkdtempSync(join(tmpdir(), "faux-workflows-"));
    const entete = "name: P\non:\n  push:\npermissions:\n  contents: read\n";
    const corps = "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n";
    writeFileSync(join(dossier, "bon.yml"), entete + corps);
    const bon = lancer("read", { workflows: dossier });
    expect(bon.stdout).toMatch(/OK\s+aucun workflow ne demande statuses: write ni checks: write/);
    expect(bon.status).toBe(0);
    writeFileSync(join(dossier, "mauvais.yml"), `${entete}  statuses: write\n${corps}`);
    const mauvais = lancer("read", { workflows: dossier });
    expect(mauvais.status).not.toBe(0);
    expect(mauvais.stdout).toMatch(/À CORRIGER.*statuses: write ni checks: write/);
  });
  it("[C-529] verifier-reglages-depot.sh échoue quand le dossier des workflows est absent", () => {
    const r = lancer("read", { workflows: join(tmpdir(), "dossier-inexistant-workflows") });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/À CORRIGER.*non vérifiable/);
    expect(r.stdout).not.toMatch(/OK\s+aucun workflow/);
  });
  it("[C-529] verifier-reglages-depot.sh échoue quand node échoue sans ligne de verdict", () => {
    const dossier = mkdtempSync(join(tmpdir(), "faux-workflows-"));
    writeFileSync(join(dossier, "bon.yml"), "name: P\non:\n  push:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n");
    const r = lancer("read", { workflows: dossier, env: { NODE_OPTIONS: "--option-qui-nexiste-pas" } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/À CORRIGER.*non vérifiable/);
    expect(r.stdout).not.toMatch(/OK\s+aucun workflow/);
  });
  it("[C-529] verifier-reglages-depot.sh ne confond pas une autre erreur d'un fichier checks.yml avec la garde", () => {
    const dossier = mkdtempSync(join(tmpdir(), "faux-workflows-"));
    writeFileSync(join(dossier, "checks.yml"), "name: P\non:\n  push:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: self-hosted\n    steps:\n      - run: echo ok\n");
    const r = lancer("read", { workflows: dossier });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toMatch(/OK\s+aucun workflow/);
    expect(r.stdout).toMatch(/À CORRIGER.*non vérifiable|À CORRIGER.*aucun workflow/);
    expect(r.stdout).not.toContain("self-hosted");
  });
});
