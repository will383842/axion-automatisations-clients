import { describe, expect, it } from "vitest";
import { creerMasqueur } from "../plugins/journal.js";
import { creerOuvreurConnexions, creerLecteurMotDePasse, creerRegistreBases } from "./adaptateurs.js";

// Adaptateurs de PortsDonnees (T2-37c, étape 1). Aucun réseau : OpenBao et PgBouncer sont simulés.
const MDP = "mot-de-passe-genere-pour-l-essai-0001";
const NOM = "cli_0123456789ab";
const reponse = (corps: unknown, status = 200) => new Response(JSON.stringify(corps), { status });
function bao(statut = 200, valeur: unknown = MDP) {
  const appels: { url: string; jeton: string | undefined; redirect: string | undefined }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    appels.push({ url, jeton: (init?.headers as Record<string, string> | undefined)?.["X-Vault-Token"], redirect: init?.redirect });
    return reponse({ data: { data: { valeur } } }, statut);
  }) as unknown as typeof fetch;
  return { appels, lecteur: creerLecteurMotDePasse({ url: "http://bao.test", jeton: "jeton-essai-api", fetch: f, masqueur: creerMasqueur() }) };
}

describe("registre des bases (lecture)", () => {
  it("[C-536] @isolation la base se lit pour le client de la session, par la connexion limitée à ce client", async () => {
    const vus: unknown[][] = [];
    const registre = creerRegistreBases(async (tenantId, fn) => fn({ requete: async (t, v) => { vus.push([tenantId, t, v]); return [{ nom_base: NOM, etat: "active" }]; } }));
    expect(await registre("11111111-1111-4111-8111-111111111111")).toEqual({ nomBase: NOM, etat: "active" });
    expect(vus[0]![1]).toMatch(/FROM bases_client WHERE tenant_id = \$1/);
    expect(vus[0]![2]).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
  it("[C-536] @isolation aucune ligne, ou un nom de base qui n'est pas cli_<12 hex>, vaut pas de base", async () => {
    expect(await creerRegistreBases(async (_t, fn) => fn({ requete: async () => [] }))("11111111-1111-4111-8111-111111111111")).toBeUndefined();
    expect(await creerRegistreBases(async (_t, fn) => fn({ requete: async () => [{ nom_base: "postgres", etat: "active" }] }))("11111111-1111-4111-8111-111111111111")).toBeUndefined();
    expect(await creerRegistreBases(async (_t, fn) => fn({ requete: async () => [{ nom_base: `${NOM}"; DROP`, etat: "active" }] }))("11111111-1111-4111-8111-111111111111")).toBeUndefined();
  });
  it("[A-170] un identifiant de client qui n'est pas un UUID n'atteint pas la base", async () => {
    let appels = 0;
    const registre = creerRegistreBases(async (_t, fn) => { appels += 1; return fn({ requete: async () => [] }); });
    expect(await registre("x' OR '1'='1")).toBeUndefined();
    expect(appels).toBe(0);
  });
});

describe("lecture des mots de passe dans OpenBao (politique api)", () => {
  it("[C-012] le mot de passe app se lit à technique/data/donnees/<base>/app avec le jeton de l'API, sans redirection", async () => {
    const b = bao();
    expect(await b.lecteur.lire(NOM, "app")).toBe(MDP);
    expect(b.appels).toEqual([{ url: `http://bao.test/v1/technique/data/donnees/${NOM}/app`, jeton: "jeton-essai-api", redirect: "error" }]);
  });
  it("[C-012] le mot de passe lecture se lit à …/lecture", async () => {
    const b = bao();
    await b.lecteur.lire(NOM, "lecture");
    expect(b.appels[0]!.url).toBe(`http://bao.test/v1/technique/data/donnees/${NOM}/lecture`);
  });
  it("[C-012] @isolation seuls app et lecture, et seul un nom cli_<12 hex>, sont lus ; rien ne part au réseau sinon", async () => {
    const b = bao();
    for (const [n, r] of [[NOM, "proprietaire"], [NOM, "provisionneur"], [NOM, "../x"], ["cli_0123", "app"], ["cli_0123456789AB", "app"], [`${NOM}/../autre`, "app"], ["pgbouncer-admin", "app"]] as const) {
      await expect(b.lecteur.lire(n, r as never), `${n}/${r}`).rejects.toThrow();
    }
    expect(b.appels).toEqual([]);
  });
  it("[C-012] une erreur du coffre ne reprend ni le corps ni le mot de passe", async () => {
    for (const statut of [403, 404, 500, 503]) {
      const err = (await bao(statut).lecteur.lire(NOM, "app").catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(`${err.message} ${JSON.stringify(err)}`).not.toContain(MDP);
    }
    await expect(bao(200, "court").lecteur.lire(NOM, "app")).rejects.toThrow();
    await expect(bao(200, 12345).lecteur.lire(NOM, "app")).rejects.toThrow();
  });
  it("[A-005] le mot de passe lu est inscrit au masqueur du journal avant d'être rendu", async () => {
    const masqueur = creerMasqueur();
    const l = creerLecteurMotDePasse({ url: "http://bao.test", jeton: "j", fetch: (async () => reponse({ data: { data: { valeur: MDP } } })) as unknown as typeof fetch, masqueur });
    await l.lire(NOM, "app");
    expect(masqueur.masquer(`erreur avec ${MDP}`)).not.toContain(MDP);
  });
});

describe("ouverture de connexion par PgBouncer « données »", () => {
  function monde(connectEchoue = false) {
    const configs: Record<string, unknown>[] = [];
    const fermes: string[] = [];
    const fabrique = (cfg: Record<string, unknown>) => {
      configs.push(cfg);
      return {
        async connect() { if (connectEchoue) throw new Error(`password authentication failed for ${String(cfg["password"])}`); },
        async query(texte: string, valeurs: unknown[]) { return { rows: [{ texte, valeurs }] }; },
        async end() { fermes.push(String(cfg["database"])); },
      };
    };
    const lecteur = { lire: async (n: string, r: string) => `${MDP}-${n}-${r}` };
    return { configs, fermes, ouvrir: creerOuvreurConnexions({ hote: "pgbouncer-donnees.test", port: 6432, lecteur, fabrique: fabrique as never }) };
  }
  it("[A-170] la connexion cible la base du client avec son rôle app ou lecture, par PgBouncer, jamais le superutilisateur", async () => {
    const m = monde();
    await m.ouvrir(NOM, "app");
    await m.ouvrir(NOM, "lecture");
    expect(m.configs.map((c) => [c["host"], c["port"], c["database"], c["user"]])).toEqual([
      ["pgbouncer-donnees.test", 6432, NOM, `${NOM}_app`],
      ["pgbouncer-donnees.test", 6432, NOM, `${NOM}_lecture`],
    ]);
    expect(m.configs[0]!["password"]).toBe(`${MDP}-${NOM}-app`);
  });
  it("[C-536] @isolation un nom de base ou un rôle hors forme est refusé avant toute connexion", async () => {
    const m = monde();
    for (const [n, r] of [["postgres", "app"], [`${NOM}_app`, "app"], [NOM, "proprietaire"], [NOM, "provisionneur"]] as const) await expect(m.ouvrir(n, r as never), `${n}/${r}`).rejects.toThrow();
    expect(m.configs).toEqual([]);
  });
  it("[C-012] un échec de connexion ne laisse sortir ni le mot de passe ni le nom de la base, et ferme le client", async () => {
    const m = monde(true);
    const err = (await m.ouvrir(NOM, "app").catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(`${err.message} ${JSON.stringify(err)} ${String((err as { cause?: unknown }).cause ?? "")}`).not.toContain(MDP);
    expect(err.message).not.toContain(NOM);
    expect(m.fermes).toEqual([NOM]);
  });
  it("[A-170] la connexion rend les lignes et se ferme", async () => {
    const m = monde();
    const c = await m.ouvrir(NOM, "lecture");
    expect(await c.requete("SELECT 1", [1])).toEqual([{ texte: "SELECT 1", valeurs: [1] }]);
    await c.fermer();
    expect(m.fermes).toEqual([NOM]);
  });
});
