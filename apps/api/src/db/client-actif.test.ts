import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { avecClient, avecEquipe } from "./client-actif.js";

const CLIENT_A = "6f1c3a52-8d1e-4b7a-9c20-3e5d7a1b0c11";

type Appel = [string, (unknown[] | undefined)?];
// Faux pool : enregistre les requêtes ; `echecSur` fait échouer la requête dont le texte commence ainsi.
function fauxPool(echecSur?: string) {
  const appels: Appel[] = [];
  const client = {
    query: vi.fn(async (texte: string, valeurs?: unknown[]) => {
      appels.push([texte, valeurs]);
      if (echecSur && texte.startsWith(echecSur)) throw new Error("panne simulée");
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client, appels };
}
const textes = (appels: Appel[]) => appels.map((a) => a[0]);
// Délais posés dès le BEGIN, pour toute transaction (ADR 0010, réserve R1 de l'ADR 0042) : portée de la transaction, jamais de la session.
const DELAIS = "SELECT set_config('idle_in_transaction_session_timeout', '5s', true), set_config('lock_timeout', '5s', true)";

describe("avecClient", () => {
  it("[A-164] ouvre une transaction, fixe le client actif avec la portée de la transaction, valide puis rend la connexion", async () => {
    const { pool, client, appels } = fauxPool();
    const resultat = await avecClient(pool, CLIENT_A, async () => "fait");
    expect(resultat).toBe("fait");
    expect(textes(appels)).toEqual(["BEGIN", DELAIS, "SELECT set_config('app.tenant_id', $1, true)", "COMMIT"]);
    expect(appels[2]?.[1]).toEqual([CLIENT_A]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith();
  });

  it("[A-164] @isolation refuse un identifiant qui n'est pas un UUID, sans prendre de connexion", async () => {
    for (const mauvais of ["", "A", "6f1c3a52-8d1e-4b7a-9c20-3e5d7a1b0c1", `${CLIENT_A}\n`, `${CLIENT_A}'; DROP TABLE x; --`, "' OR ''='", " " + CLIENT_A]) {
      const { pool } = fauxPool();
      await expect(avecClient(pool, mauvais, async () => 1)).rejects.toThrow("identifiant de client invalide");
      expect(pool.connect).not.toHaveBeenCalled();
    }
  });

  it("[A-164] @isolation annule la transaction et rend la connexion quand la fonction échoue", async () => {
    const { pool, client, appels } = fauxPool();
    await expect(avecClient(pool, CLIENT_A, async () => { throw new Error("boum"); })).rejects.toThrow("boum");
    expect(textes(appels)).toEqual(["BEGIN", DELAIS, "SELECT set_config('app.tenant_id', $1, true)", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("[A-164] @isolation détruit la connexion si l'annulation échoue, au lieu de la remettre dans le pool", async () => {
    const { pool, client } = fauxPool("ROLLBACK");
    await expect(avecClient(pool, CLIENT_A, async () => { throw new Error("boum"); })).rejects.toThrow("boum");
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("[A-164] @isolation détruit la connexion si la validation échoue", async () => {
    const { pool, client } = fauxPool("COMMIT");
    await expect(avecClient(pool, CLIENT_A, async () => 1)).rejects.toThrow("panne simulée");
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("[A-131] @isolation pose idle_in_transaction_session_timeout et lock_timeout à 5 s dès le BEGIN, avec la portée de la transaction", async () => {
    const { pool, appels } = fauxPool();
    await avecClient(pool, CLIENT_A, async () => 1);
    expect(textes(appels).slice(0, 2)).toEqual(["BEGIN", DELAIS]);
    expect(DELAIS.match(/, true\)/g)).toHaveLength(2);
  });

  it("[A-164] @isolation ne fixe jamais le client actif pour la session (interdit derrière PgBouncer en mode transaction)", async () => {
    const { pool, appels } = fauxPool();
    await avecClient(pool, CLIENT_A, async (c) => { await c.query("SELECT 1"); });
    for (const [texte] of appels) expect(texte.toUpperCase().startsWith("SET ")).toBe(false);
    const fixation = appels.find(([t]) => t.includes("set_config"));
    expect(fixation?.[0]).toContain("true)");
  });
});

describe("avecClient, acteur et adresse", () => {
  it("[A-178] fixe acteur et IP avec la portée de la transaction, dans la même transaction que le client actif", async () => {
    const { pool, appels } = fauxPool();
    await avecClient(pool, CLIENT_A, async () => 1, { acteur: "agent-test", ip: "192.0.2.17" });
    expect(textes(appels)).toEqual(["BEGIN", DELAIS, "SELECT set_config('app.tenant_id', $1, true)", "SELECT set_config('app.acteur', $1, true), set_config('app.ip', $2, true)", "COMMIT"]);
    expect(appels[3]?.[1]).toEqual(["agent-test", "192.0.2.17"]);
  });

  it("[A-178] sans IP, l'IP fixée est vide ; une adresse IPv6 est acceptée", async () => {
    const sans = fauxPool();
    await avecClient(sans.pool, CLIENT_A, async () => 1, { acteur: "agent-test" });
    expect(sans.appels[3]?.[1]).toEqual(["agent-test", ""]);
    const v6 = fauxPool();
    await avecClient(v6.pool, CLIENT_A, async () => 1, { acteur: "agent-test", ip: "2001:db8::17" });
    expect(v6.appels[3]?.[1]).toEqual(["agent-test", "2001:db8::17"]);
  });

  it("[A-178] avecClient refuse une IP mal formée et un acteur vide, sans prendre de connexion", async () => {
    const mauvais = [
      { acteur: "", ip: "192.0.2.17" },
      { acteur: "   ", ip: "192.0.2.17" },
      { acteur: "x".repeat(129), ip: "192.0.2.17" },
      { acteur: "agent\nforge", ip: "192.0.2.17" },
      { acteur: "agent\u202Eforge", ip: "192.0.2.17" },
      { acteur: "agent\u200Bforge", ip: "192.0.2.17" },
      { acteur: "agent\u2028forge", ip: "192.0.2.17" },
      { acteur: "agent\u2029forge", ip: "192.0.2.17" },
      { acteur: "agent\u2066forge", ip: "192.0.2.17" },
      { acteur: "agent\uFEFFforge", ip: "192.0.2.17" },
      { acteur: "agent\u061Cforge", ip: "192.0.2.17" },
      { acteur: "agent\u180Eforge", ip: "192.0.2.17" },
      { acteur: "agent\u00ADforge", ip: "192.0.2.17" },
      { acteur: "agent\u3164forge", ip: "192.0.2.17" },
      { acteur: "\u00A0\u2003", ip: "192.0.2.17" },
      { acteur: "agent-test", ip: "300.1.1.1" },
      { acteur: "agent-test", ip: "192.0.2.17'; --" },
      { acteur: "agent-test", ip: "192.0.2.17/24" },
      { acteur: "agent-test", ip: "fe80::1%eth0" },
      { acteur: "agent-test", ip: "" },
    ];
    for (const options of mauvais) {
      const { pool } = fauxPool();
      await expect(avecClient(pool, CLIENT_A, async () => 1, options)).rejects.toThrow(/acteur|adresse/);
      expect(pool.connect).not.toHaveBeenCalled();
    }
  });

  it("[A-178] accepte un acteur de 128 caractères exactement", async () => {
    const { pool } = fauxPool();
    await expect(avecClient(pool, CLIENT_A, async () => 1, { acteur: "x".repeat(128) })).resolves.toBe(1);
  });
});

describe("avecEquipe", () => {
  it("[A-164] lit en transaction en lecture seule, sans client actif", async () => {
    const { pool, client, appels } = fauxPool();
    await avecEquipe(pool, async () => "lu");
    expect(textes(appels)).toEqual(["BEGIN READ ONLY", DELAIS, "COMMIT"]);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("[A-164] annule et rend la connexion quand la lecture échoue", async () => {
    const { pool, client, appels } = fauxPool();
    await expect(avecEquipe(pool, async () => { throw new Error("boum"); })).rejects.toThrow("boum");
    expect(textes(appels)).toEqual(["BEGIN READ ONLY", DELAIS, "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledWith();
  });
});

// Lecteur de fichier INI : sections « [nom] », lignes « cle = valeur », commentaires « ; » et « # ».
function lireIni(chemin: string): Record<string, Record<string, string>> {
  const sortie: Record<string, Record<string, string>> = {};
  let section = "";
  for (const brute of readFileSync(new URL(chemin, import.meta.url), "utf8").split("\n")) {
    const ligne = brute.trim();
    if (ligne === "" || ligne.startsWith(";") || ligne.startsWith("#")) continue;
    if (ligne.startsWith("[") && ligne.endsWith("]")) {
      section = ligne.slice(1, -1);
      sortie[section] = {};
      continue;
    }
    const egal = ligne.indexOf("=");
    if (egal < 0) throw new Error(`ligne illisible : ${ligne}`);
    (sortie[section] ??= {})[ligne.slice(0, egal).trim()] = ligne.slice(egal + 1).trim();
  }
  return sortie;
}

describe("pgbouncer.ini", () => {
  const ini = lireIni("../../../../ops/socle/pgbouncer/pgbouncer.ini");
  const reglages = ini["pgbouncer"] ?? {};

  it("[A-049] travaille en mode transaction, avec requêtes préparées prises en charge (PgBouncer 1.21 ou plus)", () => {
    expect(reglages["pool_mode"]).toBe("transaction");
    expect(Number(reglages["max_prepared_statements"])).toBeGreaterThan(0);
    expect(reglages["server_idle_timeout"]).toBe("30");
  });

  it("[A-165] exige scram-sha-256 et une liste fermée d'utilisateurs, sans administrateur", () => {
    expect(reglages["auth_type"]).toBe("scram-sha-256");
    expect(reglages["auth_file"]).toBeTruthy();
    expect(reglages["admin_users"] ?? "").toBe("");
    expect(reglages["stats_users"] ?? "").toBe("");
  });

  it("[A-164] @isolation remet la connexion serveur à zéro à chaque fin de transaction (fuite d'un SET de session)", () => {
    expect(reglages["server_reset_query"]).toBe("DISCARD ALL");
    expect(reglages["server_reset_query_always"]).toBe("1");
  });

  it("[A-186] ne déclare que les bases console et moteur, vers la base du même nom", () => {
    const bases = ini["databases"] ?? {};
    expect(Object.keys(bases).sort()).toEqual(["console", "moteur"]);
    for (const [nom, cible] of Object.entries(bases)) expect(cible).toContain(`dbname=${nom}`);
  });
});
