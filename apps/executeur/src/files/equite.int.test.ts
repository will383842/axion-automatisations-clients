import { execFileSync } from "node:child_process";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import type { Palier } from "../config.ts";
import { PlacesValkey } from "./semaphore.ts";
import { PlafondModule } from "./plafond-module.ts";
import { Repartiteur, SousFilesValkey } from "./tour-de-role.ts";

// Contre le Valkey du socle (job socle-integration), comme files.int.test.ts.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
function adresse(): { hote: string; port: string; motDePasse?: string | undefined } {
  if (process.env.TEST_VALKEY_HOTE) return { hote: process.env.TEST_VALKEY_HOTE, port: process.env.TEST_VALKEY_PORT ?? "6379" };
  const id = docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=valkey");
  const hote = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  const env = JSON.parse(docker("inspect", "-f", "{{json .Config.Env}}", id)) as string[];
  const motDePasse = env.find((e) => e.startsWith("VALKEY_MOT_DE_PASSE="))?.slice("VALKEY_MOT_DE_PASSE=".length);
  return { hote, port: "6379", motDePasse };
}
const { hote, port, motDePasse } = adresse();
const unique = () => `essai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const connexions: Redis[] = [];
const connexion = () => {
  const c = new Redis({ host: hote, port: Number(port), password: motDePasse, maxRetriesPerRequest: null });
  connexions.push(c);
  return c;
};
afterAll(async () => {
  for (const c of connexions) await c.quit();
});
const POIDS: Record<Palier, number> = { essentiel: 1, pro: 2, etendu: 4 };
const travail = (client: string, n: number, palier: Palier = "essentiel") => ({ id: `${client}-${n}`, instanceId: `inst-${client}`, clientId: client, palier });

describe("tour de rôle sur Valkey", () => {
  it("[A-414] un client avec 1 000 travaux en file ne retarde pas un autre client au-delà d'un tour (sous-files Valkey)", async () => {
    const r = new Repartiteur(new SousFilesValkey(connexion(), unique()), POIDS);
    for (let i = 0; i < 1_000; i++) await r.ajouter(travail("bruyant", i, "etendu"));
    await r.ajouter(travail("calme", 0));
    const sortis: string[] = [];
    for (let i = 0; i < 10; i++) sortis.push((await r.suivant())!.clientId);
    expect(sortis.indexOf("calme")).toBeGreaterThanOrEqual(0);
    expect(sortis.indexOf("calme")).toBeLessThanOrEqual(POIDS.etendu);
  });

  it("[A-415] le plafond par module tient sur Valkey avec 20 prises en parallèle", async () => {
    const plafond = new PlafondModule(new PlacesValkey(connexion(), unique()), { placesParModule: 3, bailPlaceMs: 60_000 });
    const r = await Promise.all(Array.from({ length: 20 }, (_, i) => plafond.acquerir("module-x", `p${i}`)));
    expect(r.filter(Boolean)).toHaveLength(3);
  });
});
