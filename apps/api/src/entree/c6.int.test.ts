import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { emettreJeton } from "../../../../packages/contrats/src/c6/jeton.js";
import { alertesEnMemoire } from "../alertes/port.js";
import { ouvrirConnexion, type Connexion } from "../files/connexion.js";
import { construireServeur } from "../serveur.js";
import { routeEntree } from "../routes/entree.js";

// Valkey du socle lancé par ops/socle/lancer.sh (job socle-integration), comme canaux/canaux.int.test.ts.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = () => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=valkey");
const attendre = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function parametres() {
  for (let i = 0; i < 60; i++) {
    const id = conteneur();
    if (id) {
      try {
        const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
        const env = JSON.parse(docker("inspect", "-f", "{{json .Config.Env}}", id)) as string[];
        if (ip) return { host: ip, port: 6379, password: env.find((e) => e.startsWith("VALKEY_MOT_DE_PASSE="))?.slice("VALKEY_MOT_DE_PASSE=".length) ?? "" };
      } catch { /* en cours de relance */ }
    }
    await attendre(1000);
  }
  throw new Error("Valkey du socle introuvable");
}
const connexions: Connexion[] = [];
afterAll(async () => { for (const c of connexions) await c.quit().catch(() => undefined); });

const MAINTENANT = Math.floor(Date.now() / 1000);
const CLE = { kid: "c6-essai-int", secret: randomBytes(32) };
const jeton = (email = "equipe@exemple.fr") => emettreJeton(CLE.secret.toString("base64"), CLE.kid, email, MAINTENANT);

function monter(memoire: Connexion["client"], ip = "192.0.2.20") {
  const serveur = construireServeur();
  routeEntree(serveur, {
    cles: { clesAcceptees: async () => [CLE] },
    memoire,
    alertes: alertesEnMemoire(),
    connexionNormale: "/connexion",
    maintenant: () => MAINTENANT,
    plancherMs: 0,
  });
  const poster = (j: string) => serveur.inject({ method: "POST", url: "/api/console/v1/entree", remoteAddress: ip, headers: { "content-type": "application/json" }, payload: JSON.stringify({ jeton: j }) });
  return { serveur, poster };
}
const passe = (r: { json(): unknown }) => (r.json() as { url: string }).url.includes("login_hint");

describe("lien signé C6 dans le vrai Valkey", () => {
  it("[C-404] un jeton déjà utilisé est refusé, même en deux usages simultanés", async () => {
    const connexion = await ouvrirConnexion(await parametres());
    connexions.push(connexion);
    const { serveur, poster } = monter(connexion.client);
    const j = jeton();
    const rs = await Promise.all(Array.from({ length: 8 }, () => poster(j)));
    expect(rs.filter(passe)).toHaveLength(1);
    expect(passe(await poster(j))).toBe(false);
    // Le jti est gardé 2 minutes au plus.
    const ttl = await connexion.client.ttl(`entree-jti:${JSON.parse(Buffer.from(j.split(".")[0] as string, "base64url").toString()).jti}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
    await serveur.close();
  }, 60_000);

  it("[C-404] Valkey arrêté : le lien est refusé", async () => {
    const connexion = await ouvrirConnexion(await parametres());
    connexions.push(connexion);
    const j = jeton("autre@exemple.fr");
    // Valkey devenu injoignable, sans toucher au service partagé : connexion coupée, puis serveur qui ne répond pas.
    connexion.client.disconnect();
    const coupe = monter(connexion.client, "192.0.2.21");
    expect((await coupe.poster(j)).json()).toEqual({ url: "/connexion" });
    const muet = new Redis({ host: "127.0.0.1", port: 9, maxRetriesPerRequest: null, retryStrategy: () => 200 });
    muet.on("error", () => undefined);
    try {
      const sans = monter(muet, "192.0.2.22");
      const r = await sans.poster(jeton("troisieme@exemple.fr"));
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ url: "/connexion" });
    } finally {
      muet.disconnect();
    }
  }, 60_000);
});
