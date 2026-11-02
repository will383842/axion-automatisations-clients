import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { coffreCourtier, identifiantsPourTache, limitesPg, type PortsIdentifiants } from "./identifiants-base.js";

const A = randomUUID();
const B = randomUUID();
const idA = A.replaceAll("-", "").slice(0, 12);
const MDP = "mot-de-passe-d-essai-un";

function monter(o: { etat?: string; gel?: boolean; proprietaire?: string | undefined; limites?: { statementTimeout: boolean; connectionLimit: number } | undefined; versionRole?: number; echecCoffre?: boolean } = {}) {
  const journal: Record<string, unknown>[] = [];
  const lus: string[] = [];
  const p: PortsIdentifiants = {
    proprietaireTache: async () => ("proprietaire" in o ? o.proprietaire : A),
    base: async () => ({ etat: (o.etat ?? "active") as "active", grappe: "donnees-1" }),
    gelActif: async () => o.gel === true,
    hote: () => "pgbouncer-donnees.test",
    limites: async () => ("limites" in o ? o.limites : { statementTimeout: true, connectionLimit: 8 }),
    versionRole: async () => o.versionRole ?? 3,
    secret: async (nomBase) => {
      lus.push(nomBase);
      if (o.echecCoffre) throw new Error(`coffre en panne, mot de passe ${MDP}`);
      return { motDePasse: MDP, version: 3 };
    },
    journal: { tracer: (e) => { journal.push(e); } },
    maintenant: () => new Date("2027-01-10T10:00:00Z"),
  };
  return { p, journal, lus };
}

describe("identifiants servis par le courtier", () => {
  it("[A-209] @isolation le courtier sert cli_<id>_app pour une tâche de ce client et refuse pour un autre", async () => {
    const m = monter();
    const ok = await identifiantsPourTache(m.p, A, "tache-1");
    expect(ok).toMatchObject({ hote: "pgbouncer-donnees.test", base: `cli_${idA}`, role: `cli_${idA}_app`, motDePasse: MDP });
    expect(ok.expire.getTime()).toBeGreaterThan(Date.parse("2027-01-10T10:00:00Z"));
    // Tâche de A demandée au nom de B : refus avant toute lecture du secret.
    const autre = monter({ proprietaire: A });
    await expect(identifiantsPourTache(autre.p, B, "tache-1")).rejects.toMatchObject({ code: "tache_etrangere" });
    // Instance passée à un autre client : la tâche n'appartient plus à A.
    const change = monter({ proprietaire: B });
    await expect(identifiantsPourTache(change.p, A, "tache-1")).rejects.toMatchObject({ code: "tache_etrangere" });
    const inconnue = monter({ proprietaire: undefined });
    await expect(identifiantsPourTache(inconnue.p, A, "tache-9")).rejects.toMatchObject({ code: "tache_etrangere" });
    expect([...autre.lus, ...change.lus, ...inconnue.lus]).toEqual([]);
  });

  it("[A-209] le courtier ne sert jamais le rôle propriétaire ni le provisionneur", async () => {
    const m = monter();
    const r = await identifiantsPourTache(m.p, A.toUpperCase(), "tache-1");
    expect(r.role).toBe(`cli_${idA}_app`);
    expect(m.lus).toEqual([`cli_${idA}`]);
    // Le lecteur de secrets du courtier ne sait lire que .../app ; aucun autre genre, aucun autre chemin.
    const appels: string[] = [];
    const lecteur = coffreCourtier({ url: "http://coffre.test", jeton: "jeton-d-essai", fetch: (async (u: string) => { appels.push(u); return new Response(JSON.stringify({ data: { data: { valeur: MDP }, metadata: { version: 3 } } })); }) as unknown as typeof fetch });
    await expect(lecteur.lire(`cli_${idA}`)).resolves.toEqual({ motDePasse: MDP, version: 3 });
    expect(appels).toEqual([`http://coffre.test/v1/technique/data/donnees/cli_${idA}/app`]);
    for (const piege of [`cli_${idA}_proprietaire`, "provisionneur", `cli_${idA}/proprietaire`, `cli_${idA}/../provisionneur`, "pgbouncer-admin", `cli_${idA}?x=1`]) {
      await expect(lecteur.lire(piege)).rejects.toMatchObject({ code: "chemin_refuse" });
    }
    expect(appels).toHaveLength(1);
  });

  it("[A-209] base gelée : aucun identifiant servi", async () => {
    for (const cas of [{ etat: "gelee" }, { etat: "en_creation" }, { etat: "active", gel: true }, { etat: "effacee" }]) {
      const m = monter(cas);
      await expect(identifiantsPourTache(m.p, A, "tache-1")).rejects.toMatchObject({ code: expect.stringMatching(/^(base_gelee|base_non_active|gel_actif)$/) });
      expect(m.lus).toEqual([]);
    }
  });

  it("[C-035] base à l'écart : le courtier refuse de servir un identifiant", async () => {
    for (const etat of ["a_l_ecart", "exportee"]) {
      const m = monter({ etat });
      await expect(identifiantsPourTache(m.p, A, "tache-1")).rejects.toMatchObject({ code: "base_a_l_ecart" });
      expect(m.lus).toEqual([]);
      expect(m.journal.at(-1)).toMatchObject({ evenement: "identifiants_refuses", code: "base_a_l_ecart" });
    }
  });

  it("[A-417] le courtier refuse de servir un rôle dont les limites manquent", async () => {
    for (const limites of [undefined, { statementTimeout: false, connectionLimit: 8 }, { statementTimeout: true, connectionLimit: -1 }]) {
      const m = monter({ limites });
      await expect(identifiantsPourTache(m.p, A, "tache-1")).rejects.toMatchObject({ code: "limites_absentes" });
      expect(m.lus).toEqual([]);
    }
  });

  it("[A-417] la lecture des limites regarde statement_timeout et CONNECTION LIMIT du rôle", async () => {
    const requetes: { texte: string; valeurs?: unknown[] }[] = [];
    const sql = { requete: async (texte: string, valeurs?: unknown[]) => { requetes.push({ texte, valeurs }); return [{ rolconnlimit: 8, rolconfig: ["statement_timeout=5s", "work_mem=4MB"] }] as never; } };
    await expect(limitesPg(sql)(`cli_${idA}_app`)).resolves.toEqual({ statementTimeout: true, connectionLimit: 8 });
    expect(requetes[0]?.valeurs).toEqual([`cli_${idA}_app`]);
    await expect(limitesPg(sql)("provisionneur")).rejects.toThrow();
  });

  it("[A-209] un secret qui ne correspond pas à la version du rôle n'est pas servi", async () => {
    const m = monter({ versionRole: 2 });
    await expect(identifiantsPourTache(m.p, A, "tache-1")).rejects.toMatchObject({ code: "secret_incoherent" });
  });

  it("[A-209] aucun mot de passe dans le journal ni dans les données de tâche ni dans une erreur", async () => {
    const m = monter();
    await identifiantsPourTache(m.p, A, "tache-1");
    expect(JSON.stringify(m.journal)).not.toContain(MDP);
    expect(m.journal[0]).toMatchObject({ evenement: "identifiants_servis", role: `cli_${idA}_app` });
    const panne = monter({ echecCoffre: true });
    const e = await identifiantsPourTache(panne.p, A, "tache-1").catch((x: unknown) => x as Error);
    expect(e).toMatchObject({ code: "coffre_indisponible" });
    expect(String((e as Error).message) + JSON.stringify(panne.journal)).not.toContain(MDP);
  });
});
