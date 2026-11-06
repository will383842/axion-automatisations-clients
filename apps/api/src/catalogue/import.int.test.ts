import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { depotSql } from "./importer.js";

// Dépôt PostgreSQL de l'import (T4-25), sur le socle lancé par ops/socle/lancer.sh (job socle-integration). Pas de Docker en routine : écrit pour la CI.
// Les échecs sont journalisés sans secret (writeSync sur la sortie d'erreur).
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cible(service: string, port: number, surcharge: string | undefined) {
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  return { host: docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', conteneur(service)), port };
}
function secret(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const ligne = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n").find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="));
  if (!ligne) throw new Error("mot de passe de test introuvable");
  return ligne.slice("SOCLE_PG_MOT_DE_PASSE=".length);
}
const equipe = new pg.Pool({ ...cible("pgbouncer", 6432, process.env["SOCLE_PG_PGBOUNCER"]), user: "console_equipe", database: "console", password: createHash("sha256").update(`${secret()}/console_equipe`).digest("hex"), max: 2, connectionTimeoutMillis: 10_000 });
equipe.on("error", () => undefined);
afterAll(() => equipe.end());

const lettres = (n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
const hex = () => createHash("sha256").update(randomUUID()).digest("hex");
const depot = depotSql(async (fn) => {
  const c = await equipe.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.acteur', 'equipe-import-essai', true), set_config('lock_timeout', '5s', true)");
    const r = await fn(async (texte, valeurs) => (await c.query(texte, valeurs)).rows as Record<string, unknown>[]);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    writeSync(2, `import.int : échec ${(e as { code?: string }).code ?? "inconnu"}\n`);
    throw e;
  } finally {
    c.release();
  }
});
const entree = (code: string, semver: string, empreinte: string) => ({
  codeAutomatisation: code,
  nomAutomatisation: "module-essai",
  semver,
  apiMoteur: "^0.1.0",
  empreinte,
  ref: `modules/${empreinte}/`,
  signature: "c2lnbmF0dXJlLWZpY3RpdmU=",
  schemaConfiguration: { type: "object", properties: { actionsAutomatiquesAutorisees: {} } },
  manifeste: { connecteurs: [{ famille: "messagerie" }], idCle: "cle-essai-1" },
});

describe("dépôt SQL de l'import", () => {
  it("[A-024] une version importée naît brouillon, l'automatisation nouvelle est créée", async () => {
    const code = `${lettres(5)}-123`;
    const r = await depot.enregistrer(entree(code, "1.0.0", hex()));
    expect(r.cree).toBe(true);
    expect(r.version.statut).toBe("brouillon");
    const ligne = (await equipe.query("SELECT v.statut, v.nature FROM versions_automatisation v JOIN automatisations a ON a.id = v.automatisation_id WHERE a.code = $1", [code])).rows[0];
    expect(ligne).toEqual({ statut: "brouillon", nature: "creation" });
  });

  it("[A-407] deux imports simultanés de la même version avec deux empreintes : une seule ligne, l'autre voit la version en place", async () => {
    const code = `${lettres(5)}-456`;
    const [a, b] = [hex(), hex()];
    const [ra, rb] = await Promise.all([depot.enregistrer(entree(code, "1.0.0", a)), depot.enregistrer(entree(code, "1.0.0", b))]);
    expect([ra.cree, rb.cree].filter(Boolean)).toHaveLength(1);
    expect(ra.version.empreinte).toBe(rb.version.empreinte);
    expect((await equipe.query("SELECT count(*)::int AS n FROM versions_automatisation v JOIN automatisations x ON x.id = v.automatisation_id WHERE x.code = $1", [code])).rows[0]?.["n"]).toBe(1);
  });

  it("[A-407] la même empreinte sous un autre numéro de version n'est pas enregistrée de nouveau", async () => {
    const code = `${lettres(5)}-789`;
    const e = hex();
    await depot.enregistrer(entree(code, "1.0.0", e));
    const r = await depot.enregistrer(entree(code, "1.1.0", e));
    expect(r.cree).toBe(false);
    expect(r.version.semver).toBe("1.0.0");
  });

  it("[C-248] un nom de module différent sous un code d'automatisation existant est refusé et n'ajoute aucune version", async () => {
    const code = `${lettres(5)}-321`;
    await depot.enregistrer(entree(code, "1.0.0", hex()));
    await expect(depot.enregistrer({ ...entree(code, "2.0.0", hex()), nomAutomatisation: "module-autre" })).rejects.toMatchObject({ code: "identifiant_deja_pris" });
    expect((await equipe.query("SELECT count(*)::int AS n FROM versions_automatisation v JOIN automatisations x ON x.id = v.automatisation_id WHERE x.code = $1", [code])).rows[0]?.["n"]).toBe(1);
  });
});
