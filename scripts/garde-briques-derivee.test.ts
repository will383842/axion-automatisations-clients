import { spawnSync } from "node:child_process";
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
  it("[A-381] garde-briques.yml : l'attestation est vérifiée après la garde des fichiers", () => {
    const pas = doc.jobs["garde-briques"]?.steps ?? [];
    expect(pas.findIndex((e) => e.run?.includes("garde-briques.ts") && !e.run.includes("--"))).toBeLessThan(pas.indexOf(etape as never));
  });
});

const COMPOSE_BUILD = "services:\n  postgres:\n    build:\n      context: ../images/postgres\n";
const compose = (texte: string) => verifierBriques([], [{ nom: "c.yml", texte }]).join("\n");

describe("garde-briques : service construit sur place (R2)", () => {
  it("[A-381] compose : un service avec build: et sans image: est refusé", () => {
    expect(compose(COMPOSE_BUILD)).toMatch(/c\.yml.*postgres.*build/);
  });
  it("[A-381] compose : build: refusé même avec image: (pull_policy: build ou --build construit sur place)", () => {
    expect(compose(`${COMPOSE_BUILD}    image: x/y:1@sha256:${"a".repeat(64)}\n    pull_policy: build\n`)).toMatch(/build/);
    expect(compose(`${COMPOSE_BUILD}    image: x/y:1@sha256:${"a".repeat(64)}\n`)).toMatch(/build/);
  });
  it("[A-381] compose : pull_policy autre que always ou missing, include et extends.file refusés", () => {
    const img = `image: x/y:1@sha256:${"a".repeat(64)}`;
    const cas: Array<[string, RegExp]> = [
      [`services:\n  a:\n    ${img}\n    pull_policy: build\n`, /pull_policy/],
      [`services:\n  a:\n    ${img}\n    pull_policy: never\n`, /pull_policy/],
      [`include:\n  - autre.yml\nservices:\n  a:\n    ${img}\n`, /include/],
      [`services:\n  a:\n    ${img}\n    extends:\n      file: autre.yml\n      service: b\n`, /extends/],
    ];
    for (const [texte, motif] of cas) expect(compose(texte), texte).toMatch(motif);
    expect(compose(`services:\n  a:\n    ${img}\n    pull_policy: always\n`)).not.toMatch(/pull_policy/);
  });
  it("[A-381] compose : build: refusé même en forme courte, avec image vide ou donnée par une variable", () => {
    for (const texte of ["services:\n  a:\n    build: .\n", "services:\n  a:\n    build: .\n    image: ''\n", "services:\n  a:\n    build: { context: . }\n    image: ${X}\n"]) {
      expect(compose(texte), texte).not.toBe("");
    }
  });
  it("[A-381] compose : les composes réels du dépôt ne construisent plus rien sur place", () => {
    for (const nom of ["ops/socle/compose.postgres.yml", "ops/compose.test.yml"]) {
      const services = (load(lire(nom)) as { services: Record<string, { build?: unknown; image?: string }> }).services;
      for (const [s, def] of Object.entries(services)) expect(def.build === undefined && typeof def.image === "string", `${nom} ${s}`).toBe(true);
    }
  });
});

describe("garde-briques : brique du dépôt GHCR sans clé derivee (R2)", () => {
  it("[A-381] brique dont l'image est sous ghcr.io/will383842/axion-automatisations-clients/ : derivee obligatoire", () => {
    const sans: Record<string, unknown> = brique();
    delete sans.derivee;
    expect(verifierBriques([{ fichier: "ops/briques/postgres.json", contenu: sans }], []).join("\n")).toMatch(/derivee.*obligatoire/);
  });
});

describe("garde-briques : audit tour 2 (R2)", () => {
  it("[A-381] brique : un port dans le nom d'hôte de l'image est refusé (ghcr.io:443 contournait derivee)", () => {
    const sans: Record<string, unknown> = brique({ image: "ghcr.io:443/will383842/axion-automatisations-clients/x" });
    delete sans.derivee;
    expect(verifierBriques([{ fichier: "ops/briques/postgres.json", contenu: sans }], []).join("\n")).toMatch(/port/);
  });
  it("[A-381] compose : provider: et image qui n'est pas un texte sont refusés", () => {
    expect(compose("services:\n  a:\n    provider:\n      type: x\n")).toMatch(/provider/);
    for (const image of ["5", "[x]"]) expect(compose(`services:\n  a:\n    image: ${image}\n`), image).toMatch(/image/);
  });
});

describe("briques réelles : images dérivées publiées par images-derivees.yml (R2)", () => {
  const brique = (nom: string) => JSON.parse(lire(`ops/briques/${nom}.json`)) as { image: string; version: string; empreinte: string; derivee: { amont: string; dockerfile: string } };
  const cas = [
    ["postgres", "postgres-derivee", "ops/images/postgres-derivee/Dockerfile"],
    ["postgres-socle", "postgres-socle", "ops/images/postgres/Dockerfile"],
  ] as const;
  for (const [fichier, paquet, dockerfile] of cas) {
    it(`[A-381] ${fichier}.json : image ${paquet} publiée, empreinte complète, FROM du Dockerfile identique à amont`, () => {
      const b = brique(fichier);
      expect(b.image).toBe(`ghcr.io/will383842/axion-automatisations-clients/${paquet}`);
      expect(b.empreinte).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(b.derivee.dockerfile).toBe(dockerfile);
      expect(lire(dockerfile)).toContain(`FROM ${b.derivee.amont}\n`);
    });
  }
  it("[A-381] le compose du socle cite l'image du socle, version et empreinte de la brique", () => {
    const b = brique("postgres-socle");
    const service = (load(lire("ops/socle/compose.postgres.yml")) as { services: { postgres: { image: string } } }).services.postgres;
    expect(service.image).toBe(`${b.image}:${b.version}@${b.empreinte}`);
  });
  it("[A-381] ops/compose.test.yml cite l'image dérivée postgres, version et empreinte de la brique", () => {
    const b = brique("postgres");
    const service = (load(lire("ops/compose.test.yml")) as { services: { postgres: { image: string } } }).services.postgres;
    expect(service.image).toBe(`${b.image}:${b.version}@${b.empreinte}`);
  });
  it("[A-381] garde-briques sur les fichiers réels : aucune erreur", () => {
    const sortie = spawnSync(process.execPath, ["scripts/garde-briques.ts"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
    expect(sortie.stderr).toBe("");
    expect(sortie.status).toBe(0);
  });
});
