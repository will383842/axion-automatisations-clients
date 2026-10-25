import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { lireYaml } from "../../../../scripts/garde-compose.js";

const RACINE = fileURLToPath(new URL("../../../../", import.meta.url));
const lire = (chemin: string) => readFileSync(join(RACINE, chemin), "utf8");
type Obj = Record<string, unknown>;
const config = () => yaml.load(lire("ops/socle/litellm/config.yaml")) as Obj;
const sect = (nom: string) => (config()[nom] ?? {}) as Obj;
const FAMILLES = ["claude-standard", "mistral-souverain", "gpt-option"];

describe("passerelle : configuration (C-024, A-058)", () => {
  it("[A-058] trois familles de modèles nommées, branchées sur le faux fournisseur, taux fictifs ronds marqués", () => {
    const modeles = config().model_list as { model_name: string; litellm_params: Obj }[];
    expect(modeles.map((m) => m.model_name)).toEqual(FAMILLES);
    for (const m of modeles) {
      expect(String(m.litellm_params.api_base)).toMatch(/^http:\/\/faux-fournisseur\.test:\d+\/v1$/);
      expect(m.litellm_params.input_cost_per_token).toBe(0.0001);
      expect(m.litellm_params.output_cost_per_token).toBe(0.0001);
      expect(String(m.litellm_params.api_key)).toMatch(/^os\.environ\/FOURNISSEUR_/);
    }
    expect(lire("ops/socle/litellm/config.yaml")).toContain("fictif");
  });
  it("[C-024] attaque : le texte des échanges n'est gardé ni dans les journaux ni dans la base", () => {
    expect(sect("litellm_settings").turn_off_message_logging).toBe(true);
    expect(sect("general_settings").store_prompts_in_spend_logs).toBe(false);
    expect(sect("litellm_settings").set_verbose).not.toBe(true);
    expect(sect("general_settings").disable_spend_logs).not.toBe(true);
  });
  it("[C-024] attaque : aucun cache, aucun rappel vers un service tiers", () => {
    const l = sect("litellm_settings");
    expect(l.cache).toBe(false);
    for (const k of ["success_callback", "failure_callback", "callbacks", "service_callback"]) expect(l[k] ?? []).toEqual([]);
    expect(JSON.stringify(config())).not.toMatch(/langfuse|otel|opentelemetry|datadog|sentry|prometheus|s3_callback|logging_only/i);
  });
  it("[A-058] attaque : aucun réglage hors de la liste connue de la version libre (aucune fonction enterprise)", () => {
    const permis: Record<string, string[]> = {
      "": ["model_list", "litellm_settings", "general_settings"],
      litellm_settings: ["turn_off_message_logging", "cache", "set_verbose", "success_callback", "failure_callback", "callbacks"],
      general_settings: ["store_prompts_in_spend_logs", "database_url"],
    };
    expect(Object.keys(config()).sort()).toEqual(permis[""]?.slice().sort());
    for (const s of ["litellm_settings", "general_settings"]) for (const k of Object.keys(sect(s))) expect(permis[s]).toContain(k);
  });
  it("[C-598] attaque : ni clé maîtresse ni clé de fournisseur en clair dans la configuration", () => {
    expect(sect("general_settings").master_key).toBeUndefined();
    expect(String(sect("general_settings").database_url)).toMatch(/^os\.environ\//);
  });
});

describe("passerelle : clés et coffre (C-598 d)", () => {
  it("[C-598] attaque : la clé maîtresse n'est dans aucun fichier du dépôt ni dans aucune variable des fragments compose", () => {
    const fichiers = execFileSync("git", ["ls-files", "-z"], { cwd: RACINE }).toString().split("\0").filter(Boolean);
    for (const f of fichiers.filter((x) => /\.(ya?ml|json|sh|ts|mjs|env|md|hcl|sql)$/.test(x))) {
      const texte = lire(f);
      expect(texte, f).not.toMatch(/LITELLM_MASTER_KEY\s*[:=]\s*["']?(?!\$\{|os\.environ|["'])[A-Za-z0-9_-]{8,}/);
      expect(texte, f).not.toMatch(/\bsk-(?!TEST-NE-PAS-UTILISER-)[A-Za-z0-9]{20,}/);
    }
    for (const f of fichiers.filter((x) => /^ops\/socle\/compose\..*\.ya?ml$/.test(x))) {
      const services = (lireYaml(lire(f)) as { services?: Record<string, { environment?: unknown }> }).services ?? {};
      for (const s of Object.values(services)) {
        const env = s.environment;
        const noms = Array.isArray(env) ? env.map((e) => String(e).split("=")[0]) : Object.keys((env ?? {}) as Obj);
        expect(noms.filter((n) => /MASTER_KEY|^FOURNISSEUR_|SALT_KEY|_API_KEY$/.test(n ?? ""))).toEqual([]);
      }
    }
  });
  it("[C-598] attaque : la politique passerelle est en lecture seule sur deux chemins exacts, sans joker", () => {
    const t = lire("ops/socle/openbao/politiques/passerelle.hcl").split("\n").filter((l) => !l.trim().startsWith("#") && l.trim());
    const chemins = t.filter((l) => l.startsWith("path ")).map((l) => l.split('"')[1]);
    expect(chemins).toEqual(["passerelle/data/maitre", "passerelle/data/fournisseurs"]);
    const capacites = t.filter((l) => l.includes("capabilities"));
    expect(capacites).toHaveLength(2);
    for (const l of capacites) expect(l.split("=")[1]?.trim()).toBe('["read"]');
    expect(t.join("\n")).not.toContain("*");
  });
});

// Démarrage : faux OpenBao, faux « litellm » qui écrit son environnement et ses arguments.
const MAITRE = "TEST-NE-PAS-UTILISER-maitre-1f7c";
const FOURNISSEUR = "TEST-NE-PAS-UTILISER-fournisseur-9d2e";
const dossier = mkdtempSync(join(tmpdir(), "passerelle-"));
const jetonFichier = join(dossier, "jeton");
writeFileSync(jetonFichier, "jeton-court-de-test\n");
writeFileSync(join(dossier, "litellm"), '#!/bin/sh\nenv > "$SORTIE"\nprintf "%s\\n" "$@" > "$SORTIE.args"\n');
chmodSync(join(dossier, "litellm"), 0o755);
let n = 0;
const serveurs: Server[] = [];
afterAll(() => serveurs.forEach((s) => s.close()));
async function bao(rep: (chemin: string, jeton: string | undefined) => [number, unknown]): Promise<string> {
  const s = createServer((q: IncomingMessage, r) => {
    const [code, corps] = rep(q.url ?? "", q.headers["x-vault-token"] as string | undefined);
    r.writeHead(code, { "content-type": "application/json", ...(code === 307 ? { location: String(corps) } : {}) }).end(code === 307 ? "" : JSON.stringify(corps));
  });
  serveurs.push(s);
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
const sain = (chemin: string, jeton: string | undefined): [number, unknown] =>
  jeton !== "jeton-court-de-test" ? [403, { errors: ["permission denied"] }]
  : chemin === "/v1/passerelle/data/maitre" ? [200, { data: { data: { cle: MAITRE } } }]
  : chemin === "/v1/passerelle/data/fournisseurs" ? [200, { data: { data: { FOURNISSEUR_FAUX_CLE: FOURNISSEUR } } }]
  : [404, {}];
async function demarrer(adresse: string, env: Record<string, string> = {}) {
  const sortie = join(dossier, `sortie-${n++}`);
  const r = await new Promise<{ code: number | null; texte: string }>((ok) => {
    const p = spawn("sh", [join(RACINE, "ops/socle/litellm/demarrer.sh")], { env: { PATH: `${dossier}:${process.env.PATH}`, BAO_ADDR: adresse, BAO_JETON_FICHIER: jetonFichier, SORTIE: sortie, ...env } });
    let texte = "";
    p.stdout.on("data", (d: Buffer) => (texte += d.toString()));
    p.stderr.on("data", (d: Buffer) => (texte += d.toString()));
    p.on("close", (code) => ok({ code, texte }));
  });
  const lu = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return undefined; } };
  return { ...r, env: lu(sortie), args: lu(`${sortie}.args`) };
}

describe("passerelle : démarrage (C-598 d)", () => {
  it("[C-598] les clés lues dans OpenBao arrivent dans l'environnement du processus seulement, jamais en argument ni à l'écran", async () => {
    const r = await demarrer(await bao(sain));
    expect(r.code).toBe(0);
    expect(r.env).toContain(`LITELLM_MASTER_KEY=${MAITRE}`);
    expect(r.env).toContain(`FOURNISSEUR_FAUX_CLE=${FOURNISSEUR}`);
    expect(r.env).not.toMatch(/BAO_ADDR|BAO_JETON/);
    expect(`${r.args}${r.texte}`).not.toContain(MAITRE);
    expect(`${r.args}${r.texte}`).not.toContain(FOURNISSEUR);
  });
  it("[C-598] OpenBao scellé → la passerelle ne démarre pas, sans repli", async () => {
    const r = await demarrer(await bao(() => [503, { errors: ["Vault is sealed"] }]));
    expect(r.code).not.toBe(0);
    expect(r.env).toBeUndefined();
  });
  it("[C-598] OpenBao injoignable, jeton absent, secret vide ou manquant → arrêt en erreur", async () => {
    const mort = await bao(sain);
    serveurs.pop()?.close();
    expect((await demarrer(mort)).env).toBeUndefined();
    expect((await demarrer(await bao(sain), { BAO_JETON_FICHIER: join(dossier, "absent") })).env).toBeUndefined();
    expect((await demarrer(await bao((c, j) => (c.endsWith("maitre") ? [200, { data: { data: { cle: "" } } }] : sain(c, j))))).env).toBeUndefined();
    expect((await demarrer(await bao((c, j) => (c.endsWith("fournisseurs") ? [404, {}] : sain(c, j))))).env).toBeUndefined();
  });
  it("[C-598] attaque : une clé déjà présente dans l'environnement de déploiement fait refuser le démarrage", async () => {
    const a = await bao(sain);
    expect((await demarrer(a, { LITELLM_MASTER_KEY: "TEST-NE-PAS-UTILISER-en-clair" })).env).toBeUndefined();
    expect((await demarrer(a, { FOURNISSEUR_FAUX_CLE: "TEST-NE-PAS-UTILISER-en-clair" })).env).toBeUndefined();
  });
  it("[C-598] attaque : un secret qui tente de poser PATH ou LD_PRELOAD est refusé, le processus n'est pas lancé", async () => {
    for (const nom of ["PATH", "LD_PRELOAD", "PYTHONPATH", "LITELLM_MASTER_KEY", "fournisseur_x", "FOURNISSEUR_"]) {
      const a = await bao((c, j) => (c.endsWith("fournisseurs") ? [200, { data: { data: { [nom]: "x" } } }] : sain(c, j)));
      expect((await demarrer(a)).env, nom).toBeUndefined();
    }
  });
  it("[C-598] attaque : le jeton court ne suit jamais une redirection", async () => {
    let vu: string | undefined;
    const cible = await bao((_c, j) => { vu = j; return [200, {}]; });
    const a = await bao(() => [307, `${cible}/vole`]);
    expect((await demarrer(a)).env).toBeUndefined();
    expect(vu).toBeUndefined();
  });
  it("[C-024] attaque : le point d'entrée n'active aucun mode de débogage qui écrirait les échanges", () => {
    const t = lire("ops/socle/litellm/demarrer.sh");
    expect(t).not.toMatch(/--detailed_debug|--debug|LITELLM_LOG|set -x|\bset -[a-z]*x/);
    expect(spawnSync("sh", ["-n", join(RACINE, "ops/socle/litellm/demarrer.sh")]).status).toBe(0);
  });
});

// Faux fournisseur : lancé comme dans la CI, sur un port libre.
describe("passerelle : faux fournisseur (C-024)", () => {
  let adresse = "";
  const proc = spawn("node", [join(RACINE, "ops/socle/litellm/faux-fournisseur.mjs")], { env: { PATH: process.env.PATH ?? "", PORT: "0" } });
  let sortie = "";
  proc.stderr.on("data", (d: Buffer) => (sortie += d.toString()));
  const pret = new Promise<void>((ok) => proc.stdout.on("data", (d: Buffer) => { sortie += d.toString(); const m = /ECOUTE (\d+)/.exec(sortie); if (m) { adresse = `http://127.0.0.1:${m[1]}`; ok(); } }));
  afterAll(() => { proc.kill(); });
  const appeler = async (contenu: string) => (await fetch(`${adresse}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "x", messages: [{ role: "user", content: contenu }] }) })).json() as Promise<{ choices: { message: { content: string } }[]; usage: Obj }>;
  it("[A-059] répond au format chat completions avec un usage déterministe et renvoie le marqueur", async () => {
    await pret;
    const a = await appeler("un deux trois");
    const b = await appeler("un deux trois");
    expect(a.usage).toEqual(b.usage);
    expect(a.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 5 });
    expect(a.choices[0]?.message.content).toContain("un deux trois");
  });
  it("[C-024] le compteur prouve l'absence de cache et le contenu n'est écrit dans aucune sortie du processus", async () => {
    await pret;
    const marqueur = `MARQUEUR-${Date.now()}`;
    const avant = ((await (await fetch(`${adresse}/compteur`)).json()) as { appels: number }).appels;
    await appeler(marqueur);
    await appeler(marqueur);
    expect(((await (await fetch(`${adresse}/compteur`)).json()) as { appels: number }).appels).toBe(avant + 2);
    expect(sortie).not.toContain(marqueur);
  });
  it("[C-024] attaque : corps énorme ou JSON invalide refusé sans écho ni plantage", async () => {
    await pret;
    const gros = await fetch(`${adresse}/v1/chat/completions`, { method: "POST", body: "x".repeat(2_000_000) }).catch(() => undefined);
    expect(gros === undefined || gros.status >= 400).toBe(true);
    expect((await fetch(`${adresse}/v1/chat/completions`, { method: "POST", body: "{pas du json" })).status).toBe(400);
    expect((await fetch(`${adresse}/compteur`)).status).toBe(200);
  });
});
