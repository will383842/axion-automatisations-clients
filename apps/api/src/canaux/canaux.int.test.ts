import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { EN_TETES, signer } from "../../../../packages/contrats/src/commun/signature.js";
import { ouvrirConnexion, type Connexion } from "../files/connexion.js";
import { brancherErreurs } from "../plugins/erreurs.js";
import { enregistrerCanal } from "./verifier-entrant.js";

// Valkey du socle lancé par ops/socle/lancer.sh (job socle-integration), comme files/valkey.int.test.ts.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = () => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=valkey");
const attendre = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
function parametres() {
  const id = conteneur();
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  const env = JSON.parse(docker("inspect", "-f", "{{json .Config.Env}}", id)) as string[];
  return { host: ip, port: 6379, password: env.find((e) => e.startsWith("VALKEY_MOT_DE_PASSE="))?.slice("VALKEY_MOT_DE_PASSE=".length) ?? "" };
}
const connexions: Connexion[] = [];
afterAll(async () => { for (const c of connexions) await c.quit().catch(() => undefined); });

const MAINTENANT = Math.floor(Date.now() / 1000);
const HUB = { kid: "rec-hub-essai", secret: randomBytes(32) };

function monter(connexion: Connexion) {
  const serveur = Fastify({ genReqId: () => randomUUID() });
  brancherErreurs(serveur);
  const traites: unknown[] = [];
  enregistrerCanal(serveur, "hub", { cles: { clesAcceptees: async () => [HUB] }, memoire: connexion.client, actif: () => true, maintenant: () => MAINTENANT }, (s) => {
    s.post("/ecrire", async (r) => { traites.push(r.body); return { ok: true }; });
  });
  const requete = () => {
    const corps = JSON.stringify({ n: randomUUID() });
    const chemin = "/api/hub/v1/ecrire";
    return { method: "POST" as const, url: chemin, payload: corps, headers: { "content-type": "application/json", "idempotency-key": "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b", [EN_TETES.cle]: HUB.kid, [EN_TETES.horodatage]: String(MAINTENANT), [EN_TETES.signature]: signer(HUB.secret.toString("base64"), String(MAINTENANT), "POST", chemin, corps) } };
  };
  return { serveur, traites, requete };
}

describe("anti-rejeu dans le vrai Valkey", () => {
  it("[A-345] Valkey arrêté : la requête est refusée, jamais acceptée", async () => {
    const connexion = await ouvrirConnexion(parametres());
    connexions.push(connexion);
    const { serveur, traites, requete } = monter(connexion);
    const q = requete();
    expect((await serveur.inject(q)).statusCode).toBe(200);
    expect((await serveur.inject(q)).json().erreur.code).toBe("rejeu");
    const id = conteneur();
    docker("stop", id);
    try {
      const r = await serveur.inject(requete());
      expect([r.statusCode, r.json().erreur.code]).toEqual([503, "porte_fermee"]);
      expect(traites).toHaveLength(1);
    } finally {
      docker("start", id);
      for (let i = 0; i < 60 && docker("inspect", "-f", "{{.State.Health.Status}}", id) !== "healthy"; i++) await attendre(1000);
    }
  });
});
