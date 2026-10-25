import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import { appeler, ErreurCoffre, type OptionsBao } from "./coffre.js";
import { creerClesEchanges } from "./cles-echanges.js";
import { creerSignature } from "./signature.js";

// Tests contre de VRAIS OpenBao lancés par le test (deux conteneurs jetables de la même image que le socle).
// Mode dev admis pour les droits ; le secours (A-303) utilise deux OpenBao en stockage raft (le mode dev stocke en mémoire).
// Les jetons et la part de déverrouillage de test sont générés au lancement, jamais écrits dans un fichier ni affichés.
const racineDepot = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const compose = lireYaml(readFileSync(racineDepot("ops/socle/compose.openbao.yml"), "utf8")) as unknown as { services: { openbao: { image: string } } };
const IMAGE = compose.services.openbao.image;
const lancés: string[] = [];
afterAll(() => { for (const id of lancés) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ } });

interface Instance { racine: OptionsBao; jeton: (role: string) => Promise<OptionsBao> }

async function lancer(): Promise<Instance> {
  const jetonRacine = `TEST-NE-PAS-UTILISER-${randomBytes(12).toString("hex")}`;
  const id = docker("run", "-d", "--rm", "-e", `BAO_DEV_ROOT_TOKEN_ID=${jetonRacine}`, "-e", "BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200", IMAGE, "server", "-dev");
  lancés.push(id);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  const url = `http://${ip}:8200`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/v1/sys/health`)).status === 200) break; } catch { /* démarrage */ }
    if (i > 60) throw new Error(`OpenBao de test non démarré : ${docker("logs", id).split("\n").filter((l) => /err|fail|unknown|flag/i.test(l) && !/token/i.test(l)).slice(0, 5).join(" | ")}`);
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const racine: OptionsBao = { url, jeton: jetonRacine };
  const admin = (methode: "POST", chemin: string, corps: unknown) => appelerAdmin(racine, methode, chemin, corps);
  await admin("POST", "sys/mounts/transit", { type: "transit" });
  await admin("POST", "sys/mounts/technique", { type: "kv", options: { version: "2" } });
  const roles = ["api", "courtier", "equipe", "signature", "echanges", "secours"];
  for (const r of roles) await admin("POST", `sys/policies/acl/${r}`, { policy: readFileSync(racineDepot(`ops/socle/openbao/politiques/${r}.hcl`), "utf8") });
  return {
    racine,
    async jeton(role) {
      const r = (await admin("POST", "auth/token/create", { policies: [role], no_default_policy: true })) as { auth: { client_token: string } };
      return { url, jeton: r.auth.client_token };
    },
  };
}

// Deux OpenBao raft avec la configuration du socle (montée en lecture seule), initialisés avec une seule part : pour le test seulement.
interface InstanceRaft { url: string; racine: string; part: string }
async function lancerRaft(): Promise<InstanceRaft> {
  const id = docker("run", "-d", "--rm", "-v", `${racineDepot("ops/socle/openbao")}:/openbao/config:ro`, IMAGE, "server");
  lancés.push(id);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  const url = `http://${ip}:8200`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/v1/sys/health`)).status === 501) break; } catch { /* démarrage */ }
    if (i > 60) throw new Error("OpenBao raft de test non démarré");
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const init = (await appelerAdmin({ url, jeton: "" }, "POST", "sys/init", { secret_shares: 1, secret_threshold: 1 })) as { keys_base64: string[]; root_token: string };
  const instance = { url, racine: init.root_token, part: init.keys_base64[0] ?? "" };
  await deverrouiller(instance);
  return instance;
}
async function deverrouiller(i: InstanceRaft): Promise<void> {
  await appelerAdmin({ url: i.url, jeton: "" }, "POST", "sys/unseal", { key: i.part });
  for (let n = 0; ; n++) {
    try { if ((await fetch(`${i.url}/v1/sys/health`)).status === 200) return; } catch { /* attente */ }
    if (n > 60) throw new Error("OpenBao raft de test non déverrouillé");
    await new Promise((ok) => setTimeout(ok, 500));
  }
}
async function jetonRole(i: InstanceRaft, role: string): Promise<OptionsBao> {
  const r = (await appelerAdmin({ url: i.url, jeton: i.racine }, "POST", "auth/token/create", { policies: [role], no_default_policy: true })) as { auth: { client_token: string } };
  return { url: i.url, jeton: r.auth.client_token };
}
// Instantané raft (corps binaire) : hors du filtre de coffre.ts, appelé par un fetch du test.
const prendreInstantane = (i: InstanceRaft, jeton: string) => fetch(`${i.url}/v1/sys/storage/raft/snapshot`, { headers: { "X-Vault-Token": jeton } });

// Appels d'administration du test (chemins sys/ et auth/ : hors du filtre de coffre.ts, qui ne couvre que clients/ et transit/).
async function appelerAdmin(o: OptionsBao, methode: string, chemin: string, corps: unknown): Promise<unknown> {
  const r = await fetch(`${o.url}/v1/${chemin}`, { method: methode, headers: { "X-Vault-Token": o.jeton, "Content-Type": "application/json" }, body: JSON.stringify(corps) });
  if (r.status >= 300) throw new Error(`administration refusée (${r.status}) sur ${chemin}`);
  const texte = await r.text();
  return texte ? JSON.parse(texte) : undefined;
}

describe("OpenBao réel : clé de signature, copie de secours et clés HMAC", () => {
  it("[A-193] la clé de signature des modules est dans OpenBao et n'est pas exportable", async () => {
    const bao = await lancer();
    await creerSignature(bao.racine).creerCle();
    expect(await creerSignature(await bao.jeton("signature")).etatCle()).toEqual({ type: "ed25519", exportable: false, sauvegardeEnClair: false });
    const e = await appeler(bao.racine, "GET", "transit/export/signing-key/modules-signature").then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurCoffre);
    const sauvegarde = await fetch(`${bao.racine.url}/v1/transit/backup/modules-signature`, { headers: { "X-Vault-Token": bao.racine.jeton } });
    expect(sauvegarde.status).toBeGreaterThanOrEqual(400);
  });
  it("[A-193] signer puis vérifier une signature Ed25519 par OpenBao", async () => {
    const bao = await lancer();
    await creerSignature(bao.racine).creerCle();
    const s = creerSignature(await bao.jeton("signature")), m = Buffer.from(randomUUID());
    const signature = await s.signer(m);
    expect(await s.verifier(m, signature)).toBe(true);
    expect(await s.verifier(Buffer.from("autre"), signature)).toBe(false);
  });
  it("[A-303] l'instantané raft restauré dans un second OpenBao neuf vérifie une signature faite avant ; le jeton de signature ne peut pas le prendre", async () => {
    const premier = await lancerRaft();
    const admin = { url: premier.url, jeton: premier.racine };
    await appelerAdmin(admin, "POST", "sys/mounts/transit", { type: "transit" });
    for (const r of ["signature", "secours"]) await appelerAdmin(admin, "POST", `sys/policies/acl/${r}`, { policy: readFileSync(racineDepot(`ops/socle/openbao/politiques/${r}.hcl`), "utf8") });
    await creerSignature(admin).creerCle();
    const m = Buffer.from(randomUUID()), signature = await creerSignature(await jetonRole(premier, "signature")).signer(m);
    expect((await prendreInstantane(premier, (await jetonRole(premier, "signature")).jeton)).status).toBe(403);
    const reponse = await prendreInstantane(premier, (await jetonRole(premier, "secours")).jeton);
    expect(reponse.status).toBe(200);
    const instantane = Buffer.from(await reponse.arrayBuffer());
    expect(instantane.length).toBeGreaterThan(0);
    const second = await lancerRaft();
    const restauration = await fetch(`${second.url}/v1/sys/storage/raft/snapshot-force`, { method: "POST", headers: { "X-Vault-Token": second.racine }, body: instantane });
    expect(restauration.status).toBeLessThan(300);
    await deverrouiller({ ...second, part: premier.part });
    const restaure = { ...second, racine: premier.racine };
    expect(await creerSignature(await jetonRole(restaure, "signature")).verifier(m, signature)).toBe(true);
  });
  it("[C-015] @isolation la clé HMAC c1 est lue par la politique echanges et refusée aux politiques courtier et equipe", async () => {
    const bao = await lancer();
    const e = creerClesEchanges(await bao.jeton("echanges"));
    const cle = await e.tourner("c1", "emission");
    expect((await e.cleActive("c1", "emission")).secret.equals(cle.secret)).toBe(true);
    for (const role of ["courtier", "equipe", "api", "signature"]) {
      const autre = creerClesEchanges(await bao.jeton(role));
      await expect(autre.cleActive("c1", "emission")).rejects.toMatchObject({ code: "refuse" });
    }
  });
});
