import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import { appeler, type OptionsBao } from "../coffre/coffre.js";
import { creerEnveloppe } from "../coffre/enveloppe.js";
import { journalEchecs } from "../provisionnement/journal-echecs.js";
import { nomBaseDe } from "../provisionnement/etapes-base.js";
import { dechiffrerFlux } from "./chiffrement-flux.js";
import { dumperClient, type Cible } from "./dump-client.js";

journalEchecs(import.meta.url);

// Essai d'intégration (job socle-integration, Docker requis) : VRAI OpenBao (transit) et VRAI PostgreSQL jetables, cible = dossier local.
// Client fictif seulement. Aucune valeur secrète écrite ni affichée : le jeton racine et le marqueur sont générés au lancement.
const racine = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const image = (fichier: string, service: string) => (lireYaml(readFileSync(racine(fichier), "utf8")) as unknown as { services: Record<string, { image: string }> }).services[service]!.image;
const lances: string[] = [];
afterAll(() => { for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ } });
const attendre = async (ok: () => Promise<boolean> | boolean, quoi: string) => { for (let i = 0; i < 90; i++) { try { if (await ok()) return; } catch { /* attente */ } await new Promise((r) => setTimeout(r, 500)); } throw new Error(`${quoi} non prêt`); };

async function openbao(): Promise<OptionsBao> {
  const id = docker("run", "-d", "--rm", "-v", `${racine("ops/socle/openbao")}:/openbao/config:ro`, image("ops/socle/compose.openbao.yml", "openbao"), "server");
  lances.push(id);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  const url = `http://${ip}:8200`;
  const admin = async (jeton: string, methode: string, chemin: string, corps: unknown) => {
    const r = await fetch(`${url}/v1/${chemin}`, { method: methode, headers: { "X-Vault-Token": jeton, "Content-Type": "application/json" }, body: JSON.stringify(corps) });
    if (r.status >= 300) throw new Error(`administration refusée (${r.status})`);
    const t = await r.text(); return t ? JSON.parse(t) : undefined;
  };
  await attendre(async () => (await fetch(`${url}/v1/sys/health`)).status === 501, "OpenBao");
  const init = (await admin("", "POST", "sys/init", { secret_shares: 1, secret_threshold: 1 })) as { keys_base64: string[]; root_token: string };
  await attendre(async () => { const s = (await fetch(`${url}/v1/sys/health`)).status; if (s === 503) await admin("", "POST", "sys/unseal", { key: init.keys_base64[0] }); return s === 200; }, "OpenBao déverrouillé");
  await admin(init.root_token, "POST", "sys/mounts/transit", { type: "transit" });
  await admin(init.root_token, "POST", "sys/policies/acl/api", { policy: readFileSync(racine("ops/socle/openbao/politiques/api.hcl"), "utf8") });
  const t = (await admin(init.root_token, "POST", "auth/token/create", { policies: ["api"], no_default_policy: true })) as { auth: { client_token: string } };
  return { url, jeton: t.auth.client_token };
}

function cibleDossier(dossier: string): Cible {
  return {
    async deposer(chemin, flux) {
      const final = join(dossier, chemin); mkdirSync(dirname(final), { recursive: true });
      const parts: Buffer[] = []; for await (const p of flux) parts.push(p);
      const temp = `${final}.partiel`; writeFileSync(temp, Buffer.concat(parts), { flag: "wx" }); renameSync(temp, final);
    },
    async lister() { return []; },
    async retirer() { throw new Error("retrait_interdit_en_essai"); },
  };
}

async function baseClient() {
  const motDePasse = randomBytes(12).toString("hex");
  const id = docker("run", "-d", "--rm", "-e", `POSTGRES_PASSWORD=${motDePasse}`, image("ops/socle/compose.donnees.yml", "donnees"), "postgres");
  lances.push(id);
  await attendre(() => { docker("exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"); return true; }, "PostgreSQL");
  const tenantId = randomUUID(); const nomBase = nomBaseDe(tenantId); const marqueur = `MARQUEUR-${randomBytes(12).toString("hex")}`;
  const sql = (base: string, requete: string) => docker("exec", "-e", `PGPASSWORD=${motDePasse}`, id, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", base, "-c", requete);
  sql("postgres", `CREATE DATABASE ${nomBase}`);
  sql(nomBase, `CREATE TABLE notes (texte text); INSERT INTO notes VALUES ('${marqueur}')`);
  // --compress=0 : sinon la compression masquerait le marqueur et l'essai « rien en clair » ne prouverait rien
  const lancerDump = (base: string) => Readable.from(spawn("docker", ["exec", "-e", `PGPASSWORD=${motDePasse}`, id, "pg_dump", "--format=custom", "--compress=0", "-h", "127.0.0.1", "-U", "postgres", base]).stdout);
  return { tenantId, nomBase, marqueur, lancerDump };
}

describe("dump de nuit contre un vrai OpenBao et un vrai PostgreSQL", () => {
  it("[A-238] [C-047] le dump de la nuit est sur la cible, sans le marqueur en clair, et se relit avec la clé du client", async () => {
    const bao = await openbao(); const b = await baseClient(); const dossier = mkdtempSync(join(tmpdir(), "cible-dump-"));
    await creerEnveloppe(bao).creerCleClient(b.tenantId);
    const r = await dumperClient({ bao, lancerDump: b.lancerDump, cible: cibleDossier(dossier), marquerSauvegarde: async () => undefined }, { tenantId: b.tenantId, nomBase: b.nomBase, etat: "active" }, "2026-11-02");
    const chiffre = readFileSync(join(dossier, r.chemin));
    expect(chiffre.includes(Buffer.from(b.marqueur))).toBe(false);
    const ouvrir = async (e: { cleChiffree: string }) => Buffer.from(((await appeler(bao, "POST", `transit/decrypt/cli-${b.tenantId}`, { ciphertext: e.cleChiffree })) as { data: { plaintext: string } }).data.plaintext, "base64");
    const clair: Buffer[] = []; for await (const p of dechiffrerFlux(Readable.from([chiffre]), b.tenantId, ouvrir)) clair.push(p);
    expect(Buffer.concat(clair).includes(Buffer.from(b.marqueur))).toBe(true);
    expect(readdirSync(join(dossier, "clients"))).toHaveLength(1);
  }, 180_000);

  it("[A-245] après destruction de la clé du client (client fictif), son dump est illisible", async () => {
    const bao = await openbao(); const b = await baseClient(); const dossier = mkdtempSync(join(tmpdir(), "cible-dump-"));
    const enveloppe = creerEnveloppe(bao); await enveloppe.creerCleClient(b.tenantId);
    const r = await dumperClient({ bao, lancerDump: b.lancerDump, cible: cibleDossier(dossier), marquerSauvegarde: async () => undefined }, { tenantId: b.tenantId, nomBase: b.nomBase, etat: "active" }, "2026-11-02");
    await enveloppe.detruireCleClient(b.tenantId, `detruire-${b.tenantId}`);
    const ouvrir = async (e: { cleChiffree: string }) => Buffer.from(((await appeler(bao, "POST", `transit/decrypt/cli-${b.tenantId}`, { ciphertext: e.cleChiffree })) as { data: { plaintext: string } }).data.plaintext, "base64");
    await expect((async () => { for await (const p of dechiffrerFlux(Readable.from([readFileSync(join(dossier, r.chemin))]), b.tenantId, ouvrir)) void p; })()).rejects.toThrow();
  }, 180_000);
});
