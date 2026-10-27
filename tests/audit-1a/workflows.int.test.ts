import { readdirSync, readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { afterAll, afterEach, describe, expect, it } from "vitest";

// Porte du lot 1-A (T1A-19, partie A) : un workflow déclenché par une PR ne peut ni lire un secret ni déployer, et les journaux de la CI
// passent au contrôle des données réelles. Lecture de l'arbre YAML RÉSOLU job par job (droits hérités, conditions « if », jobs dépendants),
// en complément de scripts/garde-workflows.ts qui juge chaque fichier ligne à ligne. Tourne dans le job socle-integration avec les autres essais.
const dossier = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
type Obj = Record<string, unknown>;
const estObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const workflows = readdirSync(dossier)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ fichier: f, texte: readFileSync(`${dossier}${f}`, "utf8"), doc: load(readFileSync(`${dossier}${f}`, "utf8")) as Obj }));
const declencheurs = (doc: Obj): string[] => {
  const on = doc["on"] ?? doc["true"];
  return typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : estObj(on) ? Object.keys(on) : [];
};
const textes = (n: unknown): string[] => (typeof n === "string" ? [n] : Array.isArray(n) ? n.flatMap(textes) : estObj(n) ? Object.values(n).flatMap(textes) : []);
// Un job est exclu des PR si sa condition (ou celle d'un job dont il dépend) écarte l'évènement pull_request ou exige la branche main.
const exclutPr = (si: unknown) => typeof si === "string" && (/github\.event_name\s*!=\s*'pull_request'/.test(si) || /github\.ref\s*==\s*'refs\/heads\/main'/.test(si));

// Le job ne montre pas le rapport JSON : chaque échec et le bilan du fichier vont sur la sortie d'erreur (jamais une valeur secrète).
const FICHIER = import.meta.url.split("/").pop() ?? "";
const bilan = { verts: 0, rouges: 0, attendus: 0 };
afterEach((ctx) => {
  const r = ctx.task.result;
  const rouge = r?.state === "fail";
  if (ctx.task.fails) {
    if (rouge) bilan.attendus++;
    else writeSync(2, `ECHEC ${ctx.task.name}\nattendu rouge (défaut corrigé ?) mais vert\n`);
  } else if (rouge) {
    bilan.rouges++;
    writeSync(2, `ECHEC ${ctx.task.name}\n${(r.errors ?? []).map((e) => e.message).join("\n")}\n`);
  } else if (r?.state === "pass") bilan.verts++;
});
afterAll(() => {
  writeSync(2, `BILAN ${FICHIER} : ${bilan.verts} verts, ${bilan.rouges} rouges, ${bilan.attendus} défauts attendus\n`);
});

describe("audit 1-A · workflows et journaux de la CI", () => {
  it("[C-388] @isolation aucun job joignable depuis une PR n'a de droit d'écriture, d'environnement de déploiement ni de secret autre que le jeton automatique", () => {
    expect(workflows.length).toBeGreaterThan(5);
    const ecarts: string[] = [];
    for (const { fichier, doc } of workflows) {
      const evts = declencheurs(doc);
      if (evts.includes("pull_request_target")) ecarts.push(`${fichier} : pull_request_target`);
      if (!evts.includes("pull_request")) continue;
      const jobs = (doc["jobs"] ?? {}) as Record<string, Obj>;
      const exclu = (nom: string, vus = new Set<string>()): boolean => {
        if (vus.has(nom)) return false;
        vus.add(nom);
        const j = jobs[nom] ?? {};
        const besoins = j["needs"] === undefined ? [] : Array.isArray(j["needs"]) ? (j["needs"] as string[]) : [String(j["needs"])];
        return exclutPr(j["if"]) || besoins.some((b) => exclu(b, vus));
      };
      for (const [nom, job] of Object.entries(jobs)) {
        if (exclu(nom)) continue;
        const droits = job["permissions"] ?? doc["permissions"];
        if (droits === undefined) ecarts.push(`${fichier} · ${nom} : droits par défaut (non déclarés)`);
        if (typeof droits === "string" && droits !== "read-all" && droits !== "{}") ecarts.push(`${fichier} · ${nom} : permissions ${droits}`);
        if (estObj(droits)) for (const [k, v] of Object.entries(droits)) if (v === "write") ecarts.push(`${fichier} · ${nom} : ${k}: write`);
        if (job["environment"] !== undefined) ecarts.push(`${fichier} · ${nom} : environment`);
        for (const t of textes(job)) for (const m of t.matchAll(/\bsecrets\.(\w+)|\bsecrets\[/g)) if (m[1] !== "GITHUB_TOKEN") ecarts.push(`${fichier} · ${nom} : secrets.${m[1] ?? "[…]"}`);
        if (textes(job).some((t) => /\bsecrets\s*:\s*inherit\b/.test(t)) || job["secrets"] === "inherit") ecarts.push(`${fichier} · ${nom} : secrets: inherit`);
        if (textes(job["runs-on"]).some((t) => /self-hosted/.test(t))) ecarts.push(`${fichier} · ${nom} : self-hosted`);
      }
    }
    expect(ecarts).toEqual([]);
  });

  it("[C-388] @isolation aucun workflow ne déploie depuis une PR : déploiement seulement sur lancement manuel, et rien ne vise Coolify hors de lui", () => {
    const ecarts: string[] = [];
    for (const { fichier, doc, texte } of workflows) {
      const evts = declencheurs(doc);
      if (/coolify|deploiement\.yml/i.test(texte) && fichier !== "deploiement.yml") ecarts.push(`${fichier} : commande de déploiement`);
      if (fichier === "deploiement.yml" && evts.some((e) => e !== "workflow_dispatch")) ecarts.push(`${fichier} : déclencheur ${evts.join(", ")}`);
    }
    expect(ecarts).toEqual([]);
  });

  it("[C-391] les workflows lancés après une autre exécution (workflow_run) ne prennent jamais le code de la PR : ils lisent la branche par défaut", () => {
    const ecarts: string[] = [];
    expect(workflows.filter((w) => declencheurs(w.doc).includes("workflow_run")).map((w) => w.fichier), "témoin").toContain("controle-journaux.yml");
    for (const { fichier, doc } of workflows) {
      if (!declencheurs(doc).includes("workflow_run")) continue;
      for (const [nom, job] of Object.entries((doc["jobs"] ?? {}) as Record<string, Obj>)) {
        const t = textes(job).join("\n");
        if (/workflow_run\.head_(sha|branch)|github\.event\.workflow_run\.pull_requests/.test(t)) ecarts.push(`${fichier} · ${nom} : code de la PR`);
        const etapes = (job["steps"] ?? []) as Obj[];
        for (const e of etapes) {
          if (String(e["uses"] ?? "").startsWith("actions/checkout@")) {
            const ref = String((e["with"] as Obj | undefined)?.["ref"] ?? "");
            if (ref !== "${{ github.event.repository.default_branch }}") ecarts.push(`${fichier} · ${nom} : checkout sans la branche par défaut`);
          }
        }
      }
    }
    expect(ecarts).toEqual([]);
  });

  // Défaut constaté (T1A-19) : controle-journaux.yml ne scanne que les exécutions de « CI » et « nuit ». Les journaux des autres workflows
  // déclenchés par une PR (Socle intégration, Harnais, Sécurité, etc.) ne passent jamais au scanner des données réelles (C-531).
  // Correction attendue : ajouter ces noms à on.workflow_run.workflows de controle-journaux.yml (ou le déclencher sans filtre de nom).
  it.fails("[C-531] @lot-1b le contrôle des journaux couvre chaque workflow qui s'exécute sur une PR ou sur main", () => {
    const controle = workflows.find((w) => w.fichier === "controle-journaux.yml");
    const couverts = ((((controle?.doc["on"] ?? {}) as Obj)["workflow_run"] ?? {}) as Obj)["workflows"] as string[];
    const aCouvrir = workflows.filter((w) => w.fichier !== "controle-journaux.yml" && declencheurs(w.doc).some((e) => e === "pull_request" || e === "push")).map((w) => String(w.doc["name"])).sort();
    expect(aCouvrir.filter((n) => !couverts.includes(n))).toEqual([]);
  });
});
