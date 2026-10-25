import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chargerConfig } from "../config.js";
import { creerPool } from "../plugins/base.js";
import { construireServeur } from "../serveur.js";

// Tests contre le socle lancé (job socle-integration). L'API joint PgBouncer sur le réseau interne, avec console_app.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) =>
  docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function adresse(service: string, port: number, surcharge: string | undefined): string {
  if (surcharge) return surcharge;
  return `${docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', conteneur(service))}:${port}`;
}
function secret(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const variables = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n");
  const ligne = variables.find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="));
  if (!ligne) throw new Error("mot de passe de test introuvable");
  return ligne.slice("SOCLE_PG_MOT_DE_PASSE=".length);
}
const urlApp = () =>
  `postgres://console_app:${createHash("sha256").update(`${secret()}/console_app`).digest("hex")}@${adresse("pgbouncer", 6432, process.env["SOCLE_PG_PGBOUNCER"])}/console`;

describe("API avec le socle", () => {
  it("[A-048] l'API Fastify démarre et /sante/pret interroge la base à travers PgBouncer avec console_app", async () => {
    const config = chargerConfig({ NODE_ENV: "test", APP_DATABASE_URL: urlApp() }, "/inexistant");
    const serveur = construireServeur({ config, pool: creerPool(config.appDatabaseUrl as string) });
    await serveur.listen({ port: 0, host: "127.0.0.1" });
    const reponse = await serveur.inject({ method: "GET", url: "/sante/pret" });
    expect(reponse.statusCode).toBe(200);
    expect(reponse.json()).toEqual({ etat: "pret" });
    await serveur.close();
  });
});
