import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// Image postgres du socle (Debian + pg_partman) sans gosu, construite, scannée et publiée comme l'image dérivée (ADR 0014).

const chemin = (c: string) => fileURLToPath(new URL(`../${c}`, import.meta.url));
const lire = (c: string) => readFileSync(chemin(c), "utf8");
const DOCKERFILE = "ops/images/postgres/Dockerfile";
const WORKFLOW = ".github/workflows/images-derivees.yml";
const IMAGE = "ghcr.io/will383842/axion-automatisations-clients/postgres-socle";

type Obj = Record<string, unknown>;
const estObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const etapes = (job: unknown): Obj[] => (estObj(job) && Array.isArray(job.steps) ? job.steps.filter(estObj) : []);
const execute = (e: Obj) => (typeof e.run === "string" ? e.run : "");
const trouver = (job: unknown, motif: string) => etapes(job).findIndex((e) => execute(e).includes(motif));

function instructions(texte: string): { cmd: string; arg: string }[] {
  const sortie: { cmd: string; arg: string }[] = [];
  let courante = "";
  for (const brute of texte.split("\n")) {
    const l = brute.trim();
    if (l.startsWith("#")) continue;
    if (l.endsWith("\\")) {
      courante += `${l.slice(0, -1)} `;
      continue;
    }
    const complete = `${courante}${l}`.trim();
    courante = "";
    if (!complete) continue;
    const [cmd = "", ...reste] = complete.split(/\s+/);
    sortie.push({ cmd: cmd.toUpperCase(), arg: reste.join(" ") });
  }
  return sortie;
}

function analyserDockerfile(texte: string): string[] {
  const erreurs: string[] = [];
  const liste = instructions(texte);
  if (texte.split("\n").some((l) => /^\s*#\s*[A-Za-z]+\s*=/.test(l))) erreurs.push("directive d'analyse interdite");
  const from = liste.filter((i) => i.cmd === "FROM");
  if (from.length !== 1 || !/^postgres:16@sha256:[0-9a-f]{64}$/.test(from[0]?.arg ?? "")) erreurs.push("un seul FROM, postgres:16 épinglé par empreinte");
  const AUTORISEES = [
    /^ARG PARTMAN_VERSION=[\w.+~-]+$/,
    /^RUN apt-get update && apt-get install -y --no-install-recommends "postgresql-16-partman=\$\{PARTMAN_VERSION\}" && rm -rf \/var\/lib\/apt\/lists\/\*$/,
    /^RUN rm \/usr\/local\/bin\/gosu$/,
    /^USER postgres$/,
  ];
  for (const i of liste) {
    if (i.cmd === "FROM") continue;
    const texte = `${i.cmd} ${i.arg}`.replace(/\s+/g, " ").replace(/ ?&& ?/g, " && ");
    if (!AUTORISEES.some((m) => m.test(texte))) erreurs.push(`${i.cmd} : instruction hors liste blanche`);
  }
  const rm = liste.filter((i) => i.cmd === "RUN" && /^rm\s/.test(i.arg));
  if (rm.length !== 1 || rm[0]?.arg !== "rm /usr/local/bin/gosu") erreurs.push("RUN rm /usr/local/bin/gosu exigé, sans option");
  const iRm = liste.findIndex((i) => i === rm[0]);
  const iPartman = liste.findIndex((i) => i.cmd === "RUN" && i.arg.includes("postgresql-16-partman"));
  if (iPartman < 0) erreurs.push("pg_partman doit rester installé");
  else if (iRm >= 0 && iRm < iPartman) erreurs.push("le rm de gosu doit suivre l'installation");
  for (const i of liste) {
    if (i !== rm[0] && /gosu|su-exec/.test(i.arg)) erreurs.push(`${i.cmd} : gosu réapparaît`);
    if (["ADD", "COPY", "ENTRYPOINT", "CMD", "VOLUME", "ONBUILD", "SHELL", "HEALTHCHECK"].includes(i.cmd)) erreurs.push(`${i.cmd} interdit`);
    if (/\b(curl|wget|pip)\b|\|\s*(ba)?sh|chmod|chown/.test(i.arg)) erreurs.push(`${i.cmd} : commande interdite`);
    if (i.cmd === "ENV" || i.cmd === "ARG" && !i.arg.startsWith("PARTMAN_VERSION=")) erreurs.push(`${i.cmd} inattendu`);
  }
  const dernier = liste.at(-1);
  if (dernier?.cmd !== "USER" || dernier.arg !== "postgres") erreurs.push("la dernière instruction doit être USER postgres");
  if (liste.filter((i) => i.cmd === "USER").length !== 1) erreurs.push("un seul USER");
  return erreurs;
}

const reel = () => load(lire(WORKFLOW)) as Obj;
const jobs = () => reel().jobs as Obj;

describe("image postgres du socle : Dockerfile", () => {
  it("[A-381] image du socle : pg_partman conservé, gosu retiré, démarrage en USER postgres", () => {
    expect(analyserDockerfile(lire(DOCKERFILE))).toEqual([]);
    expect(instructions(lire(DOCKERFILE)).at(-1)).toEqual({ cmd: "USER", arg: "postgres" });
  });
  it("[A-381] image du socle : le compose n'a pas de volume de données et ne monte que l'initialisation en lecture seule", () => {
    const compose = load(lire("ops/socle/compose.postgres.yml")) as { services: { postgres: { volumes: string[] } } };
    expect(compose.services.postgres.volumes).toEqual(["./postgres/init:/docker-entrypoint-initdb.d:ro"]);
  });
  it("[A-381] image du socle : le compose ne fixe aucun « user: » sur postgres", () => {
    const sansUser = (texte: string) => !("user" in ((load(texte) as { services: { postgres: Obj } }).services.postgres));
    const reelCompose = lire("ops/socle/compose.postgres.yml");
    expect(sansUser(reelCompose)).toBe(true);
    expect(sansUser(reelCompose.replace("    restart:", "    user: root\n    restart:"))).toBe(false);
  });
  describe("attaques refusées", () => {
    const ok = lire(DOCKERFILE);
    const attaques: [string, string][] = [
      ["gosu non retiré", ok.replace(/^RUN rm .*$/m, "")],
      ["rm -f qui tait un échec", ok.replace("RUN rm ", "RUN rm -f ")],
      ["rm avant l'installation", ok.replace(/^RUN rm .*$\n/m, "").replace(/^RUN apt-get/m, "RUN rm /usr/local/bin/gosu\nRUN apt-get")],
      ["démarrage en root", ok.replace("USER postgres", "USER root")],
      ["USER absent", ok.replace("USER postgres", "")],
      ["instruction après USER", `${ok.trimEnd()}\nRUN true\n`],
      ["gosu recopié", ok.replace("USER postgres", "RUN cp /bin/busybox /usr/local/bin/gosu\nUSER postgres")],
      ["setuid", ok.replace("USER postgres", "RUN chmod u+s /bin/sh\nUSER postgres")],
      ["setuid par install", ok.replace("USER postgres", "RUN install -m 4755 /bin/bash /usr/local/bin/b\nUSER postgres")],
      ["sudo installé", ok.replace("USER postgres", "RUN apt-get install -y sudo\nUSER postgres")],
      ["heredoc RUN", ok.replace("USER postgres", "RUN <<X\nid\nX\nUSER postgres")],
      ["ENTRYPOINT remplacé", ok.replace("USER postgres", 'ENTRYPOINT ["sh"]\nUSER postgres')],
      ["FROM sur une étiquette seule", ok.replace(/@sha256:[0-9a-f]{64}/, "")],
      ["directive syntax", `# syntax=docker.io/exemple/frontend:latest\n${ok}`],
      ["pg_partman retiré", ok.replace(/postgresql-16-partman/g, "postgresql-16-cron")],
    ];
    it.each(attaques)("[A-381] Dockerfile du socle refusé : %s", (_nom, texte) => {
      expect(texte).not.toBe(ok);
      expect(analyserDockerfile(texte)).not.toEqual([]);
    });
  });
});

describe("image postgres du socle : workflow images-derivees.yml", () => {
  const blocs = (nom: "construire" | "publier") => etapes(jobs()[nom]).filter((e) => execute(e).includes("local/postgres-socle") || execute(e).includes("postgres-socle"));
  it.each(["construire", "publier"] as const)("[A-381] %s : construction, fumée, Trivy et évaluateur de l'image du socle, dans cet ordre", (nom) => {
    const job = jobs()[nom];
    const [construction, fumee, trivy, garde] = ["docker build", "pg_partman", "aquasecurity/trivy", "releve-trivy.ts --garde"].map((m) => etapes(job).findIndex((e) => execute(e).includes(m) && execute(e).includes("postgres-socle")));
    expect([construction, fumee, trivy, garde].every((n) => n >= 0)).toBe(true);
    expect(construction).toBeLessThan(fumee);
    expect(fumee).toBeLessThan(trivy);
    expect(trivy).toBeLessThan(garde);
    expect(execute(etapes(job)[construction] ?? {})).toMatch(/ ops\/images\/postgres$/);
    expect(execute(etapes(job)[construction] ?? {})).toContain("--platform linux/amd64");
    expect(execute(etapes(job)[fumee] ?? {})).toMatch(/test ! -e \/usr\/local\/bin\/gosu/);
    expect(execute(etapes(job)[garde] ?? {})).toContain("node scripts/releve-trivy.ts --garde");
  });
  it("[A-381] publier : une publication de plus que la dérivée, après l'évaluateur du socle, puis l'attestation porte l'empreinte poussée", () => {
    const publier = jobs().publier;
    const pushs = etapes(publier).filter((e) => execute(e).includes("docker push"));
    expect(pushs.map((e) => e.id)).toEqual(["pousser", "pousser-socle", "pousser-sauvegarde"]);
    const iPush = etapes(publier).findIndex((e) => e.id === "pousser-socle");
    const iGarde = etapes(publier).findIndex((e) => execute(e).includes("--garde") && execute(e).includes("postgres-socle"));
    expect(iGarde).toBeLessThan(iPush);
    const push = etapes(publier)[iPush] ?? {};
    expect(execute(push)).toContain(IMAGE);
    expect(execute(push)).toContain("RepoDigests");
    expect(push.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
    const attestation = etapes(publier)[iPush + 1] ?? {};
    expect(attestation.uses).toBe("actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8");
    expect(attestation.with).toEqual({ "subject-name": IMAGE, "subject-digest": "${{ steps.pousser-socle.outputs.empreinte }}", "push-to-registry": true });
  });
  it("[A-381] images-derivees.yml : aucune exemption, aucun .trivyignore, un seul docker login par push", () => {
    expect(existsSync(chemin(".trivyignore"))).toBe(false);
    const commandes = [...blocs("construire"), ...blocs("publier")].map(execute).join("\n");
    expect(commandes).not.toMatch(/ignore|skip-dirs|--severity|--ignore-unfixed/);
    expect(lire(WORKFLOW).match(/docker push/g)?.length).toBe(3);
  });
  it("[A-381] images-derivees.yml : l'image dérivée alpine n'est pas modifiée", () => {
    expect(lire(WORKFLOW)).toContain("-t local/postgres-derivee ops/images/postgres-derivee");
    expect(trouver(jobs().publier, "ghcr.io/will383842/axion-automatisations-clients/postgres-derivee")).toBeGreaterThanOrEqual(0);
  });
  it("[A-381] README des images : l'image du socle est décrite avec sa différence", () => {
    expect(lire("ops/images/README.md")).toContain("postgres-socle");
  });
});
