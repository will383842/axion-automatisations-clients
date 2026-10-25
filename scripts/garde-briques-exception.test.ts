import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { DELAIS_JOURS, evaluerTrivy, lireImage, verifierBriques } from "./garde-briques.js";

const racine = (chemin: string) => fileURLToPath(new URL(`../${chemin}`, import.meta.url));
const lire = (chemin: string) => readFileSync(racine(chemin), "utf8");
const EMP = `sha256:${"b".repeat(64)}`;
const MAINTENANT = new Date("2026-11-01T10:00:00Z");
const ESSAI = "ops/socle/compose.zz-essai-routage.yml";
const composeDe = (image: string) => `services:\n  x:\n    image: ${image}@${EMP}\n`;
const exception = (surcharge: Record<string, unknown> = {}) => ({
  avis: ["CVE-2026-33818", "GHSA-98x5-vq43-vc5p"],
  adr: "0013",
  decidee_le: "2026-10-25",
  expire_le: "2026-11-24",
  motif: "Image d'écho de test, jamais déployée ; aucune version corrigée publiée.",
  ...surcharge,
});
const brique = (surcharge: Record<string, unknown> = {}) => ({
  nom: "echo",
  image: "exemple/echo",
  version: "1.0.0",
  empreinte: EMP,
  licence: "Apache-2.0",
  livree: false,
  lieu: "local",
  source: "https://exemple.test/echo",
  verifie_le: "2026-10-25",
  exception_trivy: exception(),
  ...surcharge,
});
const verifier = (surcharge: Record<string, unknown> = {}, composes = [{ nom: ESSAI, texte: composeDe("exemple/echo:1.0.0") }], adrs = ["0013-exception-trivy-images-essai.md"]) =>
  verifierBriques([{ fichier: "ops/briques/echo.json", contenu: brique(surcharge) }], composes, { adrs, maintenant: MAINTENANT });
const v = (id: string, jours: number, severite = "HIGH") => ({
  VulnerabilityID: id,
  Severity: severite,
  FixedVersion: "9.9.9",
  PublishedDate: new Date(MAINTENANT.getTime() - jours * 86_400_000).toISOString(),
});
const rapport = (...vulns: unknown[]) => ({ Results: [{ Vulnerabilities: vulns }] });

describe("garde-briques : exception Trivy des images d'essai", () => {
  it("[A-381] exception Trivy : un avis nommé d'une brique d'essai, non expirée, ne fait pas échouer", () => {
    expect(verifier()).toEqual([]);
    const ex = exception() as never;
    expect(evaluerTrivy(rapport(v("CVE-2026-33818", 90)), "exemple/echo", MAINTENANT, ex)).toEqual([]);
  });
  it("[A-381] exception Trivy : un avis NON nommé de la même brique fait toujours échouer", () => {
    const ex = exception() as never;
    expect(evaluerTrivy(rapport(v("CVE-2026-33818", 90), v("CVE-2026-00001", 90)), "exemple/echo", MAINTENANT, ex)).toEqual(["CVE-2026-00001 exemple/echo"]);
    expect(evaluerTrivy(rapport(v("CVE-2026-33818", 90)), "exemple/echo", MAINTENANT)).toHaveLength(1);
  });
  it("[A-381] exception Trivy : expirée (expire_le égal ou antérieur à aujourd'hui) l'avis refait échouer", () => {
    const ex = (expire_le: string) => exception({ expire_le }) as never;
    const r = rapport(v("CVE-2026-33818", 90));
    expect(evaluerTrivy(r, "exemple/echo", MAINTENANT, ex("2026-10-31"))).toHaveLength(1);
    expect(evaluerTrivy(r, "exemple/echo", MAINTENANT, ex("2026-11-01"))).toHaveLength(1);
    expect(evaluerTrivy(r, "exemple/echo", MAINTENANT, ex("2026-11-02"))).toEqual([]);
    expect(verifier({ exception_trivy: exception({ expire_le: "2026-11-01" }) }).join("\n")).toMatch(/expire/);
  });
  it("[A-381] exception Trivy : plus de 30 jours entre decidee_le et expire_le est refusée", () => {
    expect(verifier({ exception_trivy: exception({ decidee_le: "2026-10-25", expire_le: "2026-11-24" }) })).toEqual([]);
    expect(verifier({ exception_trivy: exception({ decidee_le: "2026-10-25", expire_le: "2026-11-25" }) }).join("\n")).toMatch(/30 jours/);
    expect(verifier({ exception_trivy: exception({ decidee_le: "2026-11-02", expire_le: "2026-11-01" }) }).join("\n")).toMatch(/30 jours|expire/);
  });
  it("[A-381] exception Trivy : refusée sur une brique citée hors d'un fragment d'essai, ou citée par aucun compose", () => {
    const image = composeDe("exemple/echo:1.0.0");
    const cas: Array<[string, Array<{ nom: string; texte: string }>]> = [
      ["compose.base.yml", [{ nom: "ops/socle/compose.base.yml", texte: image }]],
      ["compose.test.yml", [{ nom: "ops/compose.test.yml", texte: image }]],
      ["fragment non d'essai", [{ nom: "ops/socle/compose.echo.yml", texte: image }]],
      ["essai et ailleurs", [{ nom: ESSAI, texte: image }, { nom: "ops/compose.test.yml", texte: image }]],
      ["aucun compose", []],
    ];
    for (const [nom, composes] of cas) expect(verifier({}, composes), nom).not.toEqual([]);
  });
  it("[A-375] exception Trivy : refusée sur une brique livree: true", () => {
    expect(verifier({ livree: true }).join("\n")).toMatch(/livrée/);
  });
  it("[A-381] exception Trivy : avis mal formé, liste vide, motif vide, date impossible ou ADR absent sont refusés (échec fermé)", () => {
    const refuse = (surcharge: Record<string, unknown>, nom: string) => expect(verifier({ exception_trivy: exception(surcharge) }), nom).not.toEqual([]);
    refuse({ avis: [] }, "liste vide");
    refuse({ avis: ["cve-2026-1"] }, "avis mal formé");
    refuse({ avis: "CVE-2026-33818" }, "avis non liste");
    refuse({ motif: "" }, "motif vide");
    refuse({ decidee_le: "2026-02-30" }, "date impossible");
    refuse({ expire_le: undefined }, "expire_le absent");
    refuse({ adr: "0099" }, "ADR absent");
    refuse({ inconnu: 1 }, "clé inconnue");
    expect(verifier({ exception_trivy: "oui" })).not.toEqual([]);
    expect(verifier({}, undefined, [])).not.toEqual([]);
  });
  it("[A-381] exception Trivy : dans les vrais fichiers ops/briques, aucune exception ne couvre une image de production", () => {
    const briques = readdirSync(racine("ops/briques")).filter((f) => f.endsWith(".json") && f !== "schema.json").map((f) => JSON.parse(lire(`ops/briques/${f}`)) as Record<string, unknown>);
    const nomsCompose = [...readdirSync(racine("ops/socle")).filter((f) => /^compose.*\.ya?ml$/.test(f)).map((f) => `ops/socle/${f}`), "ops/compose.test.yml"];
    const production = new Set<string>();
    for (const nom of nomsCompose.filter((n) => !/^ops\/socle\/compose\.zz-essai-[^/]*\.ya?ml$/.test(n))) {
      const doc = load(lire(nom)) as { services?: Record<string, { image?: string }> };
      for (const s of Object.values(doc.services ?? {})) if (s.image) production.add(lireImage(s.image).depot);
    }
    const avecException = briques.filter((b) => "exception_trivy" in b);
    expect(avecException.map((b) => b.nom)).toEqual(["whoami"]);
    for (const b of briques) if (production.has(String(b.image))) expect(b.exception_trivy, String(b.nom)).toBeUndefined();
    expect(avecException.every((b) => !production.has(String(b.image)) && b.livree === false)).toBe(true);
    const adrs = readdirSync(racine("docs/adr"));
    const composes = nomsCompose.map((nom) => ({ nom, texte: lire(nom) }));
    expect(verifierBriques(briques.map((contenu, i) => ({ fichier: `ops/briques/${String(contenu.nom)}.json`, contenu })), composes, { adrs, maintenant: new Date("2026-10-26T00:00:00Z") })).toEqual([]);
  });
  it("[A-381] exception Trivy : whoami nomme exactement les 10 avis du plan", () => {
    const b = JSON.parse(lire("ops/briques/whoami.json")) as { exception_trivy: { avis: string[] } };
    expect([...b.exception_trivy.avis].sort()).toEqual(
      ["CVE-2026-33818", "CVE-2026-39821", "CVE-2026-46600", "CVE-2026-56853", "CVE-2026-56858", "CVE-2026-56859", "CVE-2026-56860", "CVE-2026-56862", "CVE-2026-84304", "CVE-2026-84445"],
    );
  });
  it("[A-381] garde-briques.yml n'utilise ni .trivyignore, ni --ignorefile, ni --skip-files/--skip-dirs, ni --ignore-unfixed, ni --severity, et le dépôt ne contient aucun fichier .trivyignore*", () => {
    const doc = load(lire(".github/workflows/garde-briques.yml")) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    const commandes = Object.values(doc.jobs).flatMap((j) => j.steps.flatMap((s) => (s.run ? [s.run] : [])));
    expect(commandes.length).toBeGreaterThan(0);
    for (const c of commandes) expect(c).not.toMatch(/trivyignore|--ignorefile|--skip-files|--skip-dirs|--ignore-unfixed|--severity|TRIVY_(?:IGNORE|SKIP|SEVERITY)/i);
    const suivis = execFileSync("git", ["ls-files"], { cwd: racine("."), encoding: "utf8" }).split("\n");
    expect(suivis.filter((f) => /(^|\/)\.trivyignore/i.test(f))).toEqual([]);
  });
  it("[A-381] les seuils restent critique 7 jours et haute 30 jours", () => {
    expect(DELAIS_JOURS).toEqual({ CRITICAL: 7, HIGH: 30 });
  });
});
