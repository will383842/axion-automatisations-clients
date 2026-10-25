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
// Mode dev admis ici : ces conteneurs ne servent qu'à prouver les droits et la copie de secours, pas le scellement.
// Les jetons sont générés au lancement, jamais écrits dans un fichier ni affichés.
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
    expect(await creerSignature(await bao.jeton("signature")).etatCle()).toEqual({ type: "ed25519", exportable: false, sauvegardePossible: true });
    const e = await appeler(bao.racine, "GET", "transit/export/signing-key/modules-signature").then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurCoffre);
  });
  it("[A-193] signer puis vérifier une signature Ed25519 par OpenBao", async () => {
    const bao = await lancer();
    await creerSignature(bao.racine).creerCle();
    const s = creerSignature(await bao.jeton("signature")), m = Buffer.from(randomUUID());
    const signature = await s.signer(m);
    expect(await s.verifier(m, signature)).toBe(true);
    expect(await s.verifier(Buffer.from("autre"), signature)).toBe(false);
  });
  it("[A-303] le paquet de secours restauré dans un second OpenBao neuf vérifie une signature faite avant", async () => {
    const premier = await lancer();
    await creerSignature(premier.racine).creerCle();
    const m = Buffer.from(randomUUID()), signature = await creerSignature(await premier.jeton("signature")).signer(m);
    const paquet = await creerSignature(await premier.jeton("secours")).exporterSecours();
    const second = await lancer();
    await creerSignature(second.racine).restaurerSecours(paquet);
    expect(await creerSignature(await second.jeton("signature")).verifier(m, signature)).toBe(true);
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
