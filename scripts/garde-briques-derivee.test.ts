import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { listerDerivees, verifierAttestation, verifierBriques } from "./garde-briques.js";

const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../${chemin}`, import.meta.url)), "utf8");
const DEPOT = "ghcr.io/will383842/axion-automatisations-clients/postgres";
const AMONT = `postgres:16.15-alpine@sha256:${"b".repeat(64)}`;
const EMP = `sha256:${"c".repeat(64)}`;
const CHEMIN = "ops/images/postgres-derivee/Dockerfile";
const DOCKERFILE = `# commentaire\nFROM ${AMONT}\nRUN rm /usr/local/bin/gosu\nUSER postgres\n`;
const derivee = (s: Record<string, unknown> = {}) => ({ amont: AMONT, dockerfile: CHEMIN, ...s });
const brique = (s: Record<string, unknown> = {}) => ({
  nom: "postgres",
  image: DEPOT,
  version: "16.15-alpine-r7",
  empreinte: EMP,
  licence: "PostgreSQL",
  livree: false,
  lieu: "local",
  source: "https://www.postgresql.org",
  verifie_le: "2026-10-25",
  derivee: derivee(),
  ...s,
});
const verifier = (s: Record<string, unknown> = {}, dockerfile: string | null = DOCKERFILE, chemin = CHEMIN) =>
  verifierBriques([{ fichier: "ops/briques/postgres.json", contenu: brique(s) }], [], { dockerfiles: dockerfile === null ? [] : [{ chemin, texte: dockerfile }] }).join("\n");
const dock = (corps: string) => `FROM ${AMONT}\n${corps}\n`;

describe("garde-briques : brique dérivée (D3)", () => {
  it("[A-381] brique dérivée : une brique conforme est acceptée", () => {
    expect(verifier()).toBe("");
  });
  it("[A-381] brique dérivée : refusée hors ghcr.io/will383842/axion-automatisations-clients/", () => {
    for (const image of ["postgres", "docker.io/will383842/axion-automatisations-clients/postgres", "ghcr.io/autre/axion-automatisations-clients/postgres", "ghcr.io/will383842/axion-automatisations-clients-x/postgres", "ghcr.io/will383842/axion-automatisations-clients/../postgres", "ghcr.io/will383842/axion-automatisations-clients/"]) {
      expect(verifier({ image }), image).toMatch(/derivee/);
    }
  });
  it("[A-381] brique dérivée : refusée si la clé n'est pas un objet, a une clé inconnue ou perd amont ou dockerfile", () => {
    for (const d of [null, "x", [], derivee({ extra: 1 }), { dockerfile: CHEMIN }, { amont: AMONT }, derivee({ amont: 3 }), derivee({ dockerfile: "" })]) expect(verifier({ derivee: d }), JSON.stringify(d)).toMatch(/derivee/);
  });
  it("[A-381] brique dérivée : refusée si amont n'est pas épinglé par une empreinte complète en minuscules", () => {
    for (const amont of ["postgres:16.15-alpine", `postgres@sha256:${"b".repeat(63)}`, `postgres@sha256:${"B".repeat(64)}`, `postgres:16.15-alpine@sha256:${"b".repeat(64)} `]) {
      expect(verifier({ derivee: derivee({ amont }) }, `FROM ${amont}\n`), amont).toMatch(/amont/);
    }
  });
  it("[A-381] brique dérivée : refusée si l'empreinte est celle de l'amont (image non modifiée)", () => {
    expect(verifier({ empreinte: `sha256:${"b".repeat(64)}` })).toMatch(/amont/);
  });
  it("[A-381] brique dérivée : refusée si le Dockerfile cité est absent ou hors ops/images", () => {
    expect(verifier({}, null)).toMatch(/Dockerfile.*absent/);
    for (const d of ["ops/images/../../Dockerfile", "/ops/images/x/Dockerfile", "docs/Dockerfile", "ops/images/x/Dockerfile.autre", "ops/images/x/../Dockerfile"]) {
      expect(verifier({ derivee: derivee({ dockerfile: d }) }, DOCKERFILE, d), d).toMatch(/Dockerfile/);
    }
  });
  it("[A-381] brique dérivée : refusée si le FROM du Dockerfile diffère de amont (tag, autre image, scratch, variable)", () => {
    for (const from of ["postgres:16.15-alpine", `postgres:17@sha256:${"d".repeat(64)}`, "scratch", "${BASE}", `${AMONT} AS base`, `--platform=linux/arm64 ${AMONT}`]) {
      expect(verifier({}, `FROM ${from}\n`), from).toMatch(/FROM/);
    }
  });
  it("[A-381] brique dérivée : refusée si le Dockerfile a deux FROM ou aucun, même en minuscules ou après un commentaire", () => {
    expect(verifier({}, `${DOCKERFILE}FROM ${AMONT}\n`)).toMatch(/FROM/);
    expect(verifier({}, `${DOCKERFILE}from alpine\n`)).toMatch(/FROM/);
    expect(verifier({}, "# FROM seulement en commentaire\nUSER postgres\n")).toMatch(/FROM/);
  });
  it("[A-381] brique dérivée : refusée si le Dockerfile télécharge (ADD, curl, wget, | sh), y compris coupé par un retour à la ligne", () => {
    for (const corps of ["ADD https://exemple.test/x /x", "add http://exemple.test/x /x", "RUN curl -o /x https://exemple.test/x", "RUN wget https://exemple.test/x", "RUN apk add x | sh", "RUN true \\\n && cu\\\nrl https://exemple.test/x", "RUN echo x | bash", "COPY --from=autre /x /x"]) {
      expect(verifier({}, dock(corps)), corps).toMatch(/Dockerfile/);
    }
  });
  it("[A-381] brique dérivée : refusée si le Dockerfile déclare un ARG ou ENV dont le nom contient TOKEN, KEY, SECRET ou PASSWORD", () => {
    for (const corps of ["ARG GH_TOKEN", "arg api_key=1", "ENV DB_PASSWORD=1", "ENV A=1 MON_SECRET=2", "ENV Cle_Secret 3", "ARG X=1 \\\n    PASSWORD_DB"]) {
      expect(verifier({}, dock(corps)), corps).toMatch(/Dockerfile/);
    }
  });
  it("[A-381] brique dérivée : un ARG ou ENV inoffensif reste accepté", () => {
    expect(verifier({}, dock("ARG PARTMAN_VERSION=5\nENV LANG=C"))).toBe("");
  });
  it("[A-381] brique dérivée : refusée avec une exception_trivy (aucun assouplissement)", () => {
    expect(verifier({ exception_trivy: { avis: ["CVE-2026-0001"], adr: "0013", decidee_le: "2026-10-25", expire_le: "2026-11-01", motif: "x" } })).toMatch(/derivee.*exception/);
  });
  it("[A-381] brique dérivée : le mode --derivees ne liste que les briques dérivées, en image@empreinte", () => {
    const b = brique() as never;
    const autre = { ...(brique() as object), nom: "valkey", image: "valkey/valkey", derivee: undefined } as never;
    expect(listerDerivees([b, autre])).toEqual([`${DEPOT}@${EMP}`]);
  });
});

const SIGNEUR = "https://github.com/will383842/axion-automatisations-clients/.github/workflows/images-derivees.yml@refs/heads/main";
const attestation = (s: { signeur?: string; sha?: string; sujets?: unknown[]; depot?: string } = {}) => ({
  verificationResult: {
    statement: { subject: s.sujets ?? [{ name: DEPOT, digest: { sha256: s.sha ?? "c".repeat(64) } }] },
    signature: { certificate: { buildSignerURI: s.signeur ?? SIGNEUR, sourceRepositoryURI: s.depot ?? "https://github.com/will383842/axion-automatisations-clients" } },
  },
});
const attester = (sortie: unknown) => verifierAttestation(typeof sortie === "string" ? sortie : JSON.stringify(sortie), DEPOT, EMP).join("\n");

describe("garde-briques : attestation d'une image dérivée (D3)", () => {
  it("[A-381] attestation : acceptée si l'empreinte et le workflow signataire correspondent", () => {
    expect(attester([attestation()])).toBe("");
  });
  it("[A-381] attestation : refusée si absente, vide, illisible ou pas une liste", () => {
    for (const s of [[], "", "pas du json", "{}", "null", "[null]", [{}]]) expect(attester(s), JSON.stringify(s)).toMatch(/attestation/);
  });
  it("[A-381] attestation : refusée si l'empreinte attestée diffère de celle de la brique", () => {
    expect(attester([attestation({ sha: "d".repeat(64) })])).toMatch(/empreinte/);
    expect(attester([attestation({ sujets: [] })])).toMatch(/empreinte/);
  });
  it("[A-381] attestation : refusée si le signataire n'est pas images-derivees.yml de ce dépôt sur main", () => {
    const base = "https://github.com/will383842/axion-automatisations-clients/.github/workflows";
    for (const signeur of [`${base}/ci.yml@refs/heads/main`, `${base}/images-derivees.yml.autre@refs/heads/main`, `${base}/images-derivees.yml@refs/heads/lot-1a/x`, `${base}/images-derivees.yml@refs/pull/1/merge`, `${base}/images-derivees.yml`, "https://github.com/autre/axion-automatisations-clients/.github/workflows/images-derivees.yml@refs/heads/main", `${base}/images-derivees.yml@refs/heads/main2`]) {
      expect(attester([attestation({ signeur })]), signeur).toMatch(/signataire/);
    }
  });
  it("[A-381] attestation : une seule attestation valable suffit, mais une attestation valable ne couvre pas une autre empreinte", () => {
    expect(attester([attestation({ sha: "d".repeat(64) }), attestation()])).toBe("");
    expect(attester([attestation({ signeur: "x" }), attestation({ sha: "d".repeat(64) })])).not.toBe("");
  });
});

describe("garde-briques.yml : étape d'attestation (D3)", () => {
  const doc = load(lire(".github/workflows/garde-briques.yml")) as { permissions: Record<string, string>; jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string>; "continue-on-error"?: unknown; if?: unknown }> }> };
  const etape = doc.jobs["garde-briques"]?.steps.find((e) => e.run?.includes("gh attestation verify"));
  it("[A-381] garde-briques.yml vérifie l'attestation de chaque brique dérivée avec --signer-workflow images-derivees.yml", () => {
    const run = etape?.run ?? "";
    expect(run).toContain("--derivees");
    expect(run).toContain("--repo will383842/axion-automatisations-clients");
    expect(run).toContain("--signer-workflow will383842/axion-automatisations-clients/.github/workflows/images-derivees.yml");
    expect(run).toContain("--format json");
    expect(run).toContain("--attestation");
    expect(run).not.toMatch(/\|\| true|--deny-self-hosted-runners=false/);
    expect(etape?.["continue-on-error"]).toBeUndefined();
    expect(etape?.if).toBeUndefined();
    expect(etape?.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
  });
  it("[A-381] garde-briques.yml : attestations en lecture seulement, aucune autre permission d'écriture", () => {
    expect(doc.permissions).toEqual({ contents: "read", attestations: "read" });
  });
  it("[A-381] garde-briques.yml : l'attestation est vérifiée avant le scan Trivy des images", () => {
    const pas = doc.jobs["garde-briques"]?.steps ?? [];
    expect(pas.indexOf(etape as never)).toBeGreaterThan(-1);
    expect(pas.indexOf(etape as never)).toBeLessThan(pas.findIndex((e) => e.run?.includes("--trivy")));
  });
});
