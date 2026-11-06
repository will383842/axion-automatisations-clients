import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { coffreCourtier, identifiantsLecturePourTache, identifiantsPourTache, limitesPg, validiteRolePg, type PortsIdentifiants } from "./identifiants-base.js";

// T4-39b-2 (ADR 0113) : remise de cli_<id>_lecture. Données générées : aucun vrai client, aucun secret réel.
const A = randomUUID();
const B = randomUUID();
const idA = A.replaceAll("-", "").slice(0, 12);
const MDP = "mot-de-passe-d-essai-lecture";
const FIN = new Date("2027-02-01T00:00:00Z");

interface Options { proprietaire?: string | undefined; limites?: Record<string, { statementTimeout: boolean; connectionLimit: number } | undefined>; versions?: Record<string, number>; validites?: Record<string, Date | null | undefined> }
function monter(o: Options = {}) {
  const journal: Record<string, unknown>[] = [];
  const lus: string[] = [];
  const interroges: string[] = [];
  const p: PortsIdentifiants = {
    proprietaireTache: async () => ("proprietaire" in o ? o.proprietaire : A),
    base: async () => ({ etat: "active", grappe: "donnees-1" }),
    gelActif: async () => false,
    hote: () => "pgbouncer-donnees.test",
    limites: async (r) => { interroges.push(r); return o.limites && r in o.limites ? o.limites[r] : { statementTimeout: true, connectionLimit: 2 }; },
    versionRole: async (r) => { interroges.push(r); return o.versions?.[r] ?? 4; },
    validiteRole: async (r) => { interroges.push(r); return o.validites && r in o.validites ? o.validites[r] : FIN; },
    secret: async (nomBase, genre) => { lus.push(`${nomBase}/${genre}`); return { motDePasse: MDP, version: 4 }; },
    journal: { tracer: (e) => { journal.push(e); } },
    maintenant: () => new Date("2027-01-10T10:00:00Z"),
  };
  return { p, journal, lus, interroges };
}

describe("remise du rôle _lecture par le courtier", () => {
  it("[C-624] le rôle remis pour la lecture est cli_<id>_lecture (secret lecture), jamais _app ni _proprietaire", async () => {
    const m = monter();
    const r = await identifiantsLecturePourTache(m.p, A, "tache-1");
    expect(r).toMatchObject({ base: `cli_${idA}`, role: `cli_${idA}_lecture`, motDePasse: MDP });
    expect(m.lus).toEqual([`cli_${idA}/lecture`]);
    expect(m.interroges.every((x) => x === `cli_${idA}_lecture`)).toBe(true);
    // _app reste inchangé : son secret et son rôle.
    const app = monter();
    expect(await identifiantsPourTache(app.p, A, "tache-1")).toMatchObject({ role: `cli_${idA}_app` });
    expect(app.lus).toEqual([`cli_${idA}/app`]);
  });

  it("[C-624] @isolation une tâche forgée ou d'un autre client ne reçoit pas le rôle _lecture de A (tache_etrangere)", async () => {
    for (const cas of [{ tenant: B, proprietaire: A as string | undefined }, { tenant: A, proprietaire: B as string | undefined }, { tenant: A, proprietaire: undefined }]) {
      const m = monter({ proprietaire: cas.proprietaire });
      await expect(identifiantsLecturePourTache(m.p, cas.tenant, "tache-1")).rejects.toMatchObject({ code: "tache_etrangere" });
      expect(m.lus).toEqual([]);
      expect(m.interroges).toEqual([]);
    }
  });

  it("[A-209] aucun nom hors cli_<id>_(app|lecture) n'est interrogé ni servi (_proprietaire refusé)", async () => {
    const sql = { requete: async () => [{ rolconnlimit: 2, rolconfig: ["statement_timeout=5s"], rolvaliduntil: FIN }] as never };
    for (const ok of [`cli_${idA}_app`, `cli_${idA}_lecture`]) {
      await expect(limitesPg(sql)(ok)).resolves.toBeDefined();
      await expect(validiteRolePg(sql)(ok)).resolves.toBeDefined();
    }
    for (const piege of [`cli_${idA}_proprietaire`, "provisionneur", `cli_${idA}_lecture `, `cli_${idA}_lecture\n`, `x_cli_${idA}_lecture`, `cli_${idA.toUpperCase()}_lecture`, `cli_${idA}_lectur`, `cli_${idA}_app_lecture`]) {
      await expect(limitesPg(sql)(piege), piege).rejects.toThrow();
      await expect(validiteRolePg(sql)(piege), piege).rejects.toThrow();
    }
    // Le lecteur de coffre n'accepte que la liste fermée app|lecture ; le genre n'est jamais un chemin libre.
    const appels: string[] = [];
    const lecteur = coffreCourtier({ url: "http://coffre.test", jeton: "jeton-d-essai", fetch: (async (u: string) => { appels.push(u); return new Response(JSON.stringify({ data: { data: { valeur: MDP }, metadata: { version: 4 } } })); }) as unknown as typeof fetch });
    await expect(lecteur.lire(`cli_${idA}`, "lecture")).resolves.toEqual({ motDePasse: MDP, version: 4 });
    expect(appels).toEqual([`http://coffre.test/v1/technique/data/donnees/cli_${idA}/lecture`]);
    for (const genre of ["proprietaire", "../proprietaire", "app/../proprietaire", "", "LECTURE", "lecture?x=1", "provisionneur"]) {
      await expect(lecteur.lire(`cli_${idA}`, genre as never), genre).rejects.toMatchObject({ code: "chemin_refuse" });
    }
    await expect(lecteur.lire(`cli_${idA}/../proprietaire`, "lecture")).rejects.toMatchObject({ code: "chemin_refuse" });
    expect(appels).toHaveLength(1);
  });

  it("[A-169] un _lecture sans VALID UNTIL n'est pas servi (role_sans_echeance) ; _app sans échéance garde son comportement", async () => {
    const m = monter({ validites: { [`cli_${idA}_lecture`]: null } });
    await expect(identifiantsLecturePourTache(m.p, A, "tache-1")).rejects.toMatchObject({ code: "role_sans_echeance" });
    expect(m.lus).toEqual([]);
    const echu = monter({ validites: { [`cli_${idA}_lecture`]: new Date("2027-01-10T10:00:00Z") } });
    await expect(identifiantsLecturePourTache(echu.p, A, "tache-1")).rejects.toMatchObject({ code: "role_expire" });
    const app = monter({ validites: { [`cli_${idA}_app`]: null } });
    await expect(identifiantsPourTache(app.p, A, "tache-1")).resolves.toMatchObject({ valideJusqua: null });
  });

  it("[A-169] entre coffre et rôle le courtier refuse secret_incoherent pour _lecture ; l'échéance annoncée ne dépasse pas VALID UNTIL", async () => {
    const m = monter({ versions: { [`cli_${idA}_lecture`]: 3 } });
    await expect(identifiantsLecturePourTache(m.p, A, "tache-1")).rejects.toMatchObject({ code: "secret_incoherent" });
    // La version de _app ne couvre pas _lecture : chaque rôle a sa version.
    const croise = monter({ versions: { [`cli_${idA}_app`]: 4, [`cli_${idA}_lecture`]: 9 } });
    await expect(identifiantsLecturePourTache(croise.p, A, "tache-1")).rejects.toMatchObject({ code: "secret_incoherent" });
    const proche = monter({ validites: { [`cli_${idA}_lecture`]: new Date("2027-01-10T10:05:00Z") } });
    expect((await identifiantsLecturePourTache(proche.p, A, "tache-1")).expire.toISOString()).toBe("2027-01-10T10:05:00.000Z");
  });

  it("[A-417] un _lecture sans statement_timeout positif ou sans CONNECTION LIMIT n'est pas servi", async () => {
    const role = `cli_${idA}_lecture`;
    for (const limites of [undefined, { statementTimeout: false, connectionLimit: 2 }, { statementTimeout: true, connectionLimit: -1 }, { statementTimeout: true, connectionLimit: 0 }]) {
      const m = monter({ limites: { [role]: limites } });
      await expect(identifiantsLecturePourTache(m.p, A, "tache-1")).rejects.toMatchObject({ code: "limites_absentes" });
      expect(m.lus).toEqual([]);
    }
    const sql = { requete: async () => [{ rolconnlimit: 2, rolconfig: ["statement_timeout=0"] }] as never };
    await expect(limitesPg(sql)(role)).resolves.toEqual({ statementTimeout: false, connectionLimit: 2 });
  });
});
