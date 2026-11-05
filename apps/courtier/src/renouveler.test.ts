import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demarrerFauxGraph, type FauxGraph } from "../../../packages/harnais/src/faux-graph/serveur.ts";
import { creerJournal } from "./journal.js";
import { creerVerrouMemoire, type Verrou } from "./verrou.js";
import { ErreurFournisseur, ErreurRenouvellement, renouvelerSiBesoin, type ConnexionARenouveler, type PortsRenouvellement, type ReponseFournisseur, type Secret } from "./renouveler.js";

// Attaques prévues (audit) : 1 vingt demandes en même temps ; 2 jeton tournant consommé deux fois ; 3 panne entre la réponse
// du fournisseur et l'écriture ; 4 bail expiré pendant un appel lent ; 5 deux processus qui croient tenir le verrou ;
// 6 valeur de jeton dans un journal ou une erreur ; 7 connexion déjà « à vérifier » ; 8 réponse incertaine.
const T0 = 1_800_000_000_000;
const CONN: ConnexionARenouveler = { connexionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", tenantId: "11111111-1111-4111-8111-111111111111", cheminCoffre: "clients/data/t/c1", instanceIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] };
const ANCIEN_RENOUVELLEMENT = "marqueur-ancien-renouvellement-17c2";
const NOUVEAU_RENOUVELLEMENT = "marqueur-nouveau-renouvellement-93fa";
const NOUVEL_ACCES = "marqueur-nouvel-acces-5d10";

let graph: FauxGraph;
beforeAll(async () => { graph = await demarrerFauxGraph(); });
afterAll(async () => { await graph.arreter(); });

function monde(sur: Partial<PortsRenouvellement> = {}, depart: Partial<Secret> = {}) {
  let secret: Secret = { access_token: "ancien-acces", refresh_token: ANCIEN_RENOUVELLEMENT, expires_at: Math.floor(T0 / 1000) + 300, duree_s: 3600, ...depart };
  const etat = { appels: 0, ecritures: 0, rouges: [] as string[], pauses: [] as string[], averifier: [] as string[], alertes: [] as string[], lignes: [] as string[], etatConnexion: "ok" as "ok" | "a_verifier" | "rouge", horloge: T0 };
  const p: PortsRenouvellement = {
    verrou: creerVerrouMemoire(() => etat.horloge),
    journal: creerJournal((l) => etat.lignes.push(l)),
    maintenant: () => etat.horloge,
    attendre: (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 2))),
    lire: async () => ({ ...secret }),
    ecrire: async (_chemin, s) => { etat.ecritures++; secret = { ...s }; },
    fournisseur: async (): Promise<ReponseFournisseur> => {
      etat.appels++;
      return { access_token: NOUVEL_ACCES, refresh_token: NOUVEAU_RENOUVELLEMENT, expires_in: 3600 };
    },
    etatConnexion: async () => etat.etatConnexion,
    marquerRouge: async (id) => { etat.rouges.push(id); etat.etatConnexion = "rouge"; },
    mettreEnPause: async (instanceId, classe) => { etat.pauses.push(`${instanceId}:${classe}`); },
    marquerAVerifier: async (id) => { etat.averifier.push(id); etat.etatConnexion = "a_verifier"; },
    alerter: async (id, code) => { etat.alertes.push(`${id}:${code}`); },
    bailMs: 3000,
    delaiFournisseurMs: 1000,
    essaisEcriture: 3,
    attenteMaxMs: 2000,
    ...sur,
  };
  return { p, etat, secret: () => secret };
}
const erreur = async (f: Promise<unknown>) => (await f.then(() => null, (e: unknown) => e)) as ErreurRenouvellement | null;

// Adaptateur REST vers le faux Microsoft 365 (grant refresh_token), tel que le courtier le fera.
const fournisseurHttp = (clientId: string) => async (jeton: string): Promise<ReponseFournisseur> => {
  const r = await fetch(`${graph.url}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: jeton }) });
  const corps = (await r.json()) as Record<string, unknown>;
  if (r.status === 400 && corps["error"] === "invalid_grant") throw new ErreurFournisseur("invalid_grant");
  if (!r.ok) throw new ErreurFournisseur("refuse");
  return corps as unknown as ReponseFournisseur;
};
const emettreTournant = async (clientId: string) => ((await (await fetch(`${graph.url}/__tournant/emettre`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: clientId }) })).json()) as { refresh_token: string }).refresh_token;
const etatTournant = async () => (await (await fetch(`${graph.url}/__tournant/etat`)).json()) as { appels: number; revoque: boolean };
const remiseAZero = () => fetch(`${graph.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "normal", reinitialiser: true }) });

describe("renouvellement en avance", () => {
  it("[A-336] 20 remises simultanées pour la même connexion : un seul appel de renouvellement au faux fournisseur", async () => {
    await remiseAZero();
    const depart = await emettreTournant("lemoine@exemple.fr");
    const w = monde({ fournisseur: fournisseurHttp("lemoine@exemple.fr") }, { refresh_token: depart });
    const rendus = await Promise.all(Array.from({ length: 20 }, () => renouvelerSiBesoin(w.p, CONN)));
    expect((await etatTournant()).appels).toBe(1);
    expect((await etatTournant()).revoque).toBe(false);
    expect(new Set(rendus.map((r) => r.jetonAcces)).size).toBe(1);
    expect(w.etat.ecritures).toBe(1);
  });

  it("[A-336] le faux fournisseur révoque si un jeton tournant est réutilisé, et le test le prouve en provoquant la réutilisation sans verrou", async () => {
    await remiseAZero();
    const depart = await emettreTournant("garage-fontaine@exemple.fr");
    const appel = fournisseurHttp("garage-fontaine@exemple.fr");
    const premier = await appel(depart);
    const reutilise = await appel(depart).then(() => "accepte", (e: unknown) => (e as ErreurFournisseur).kind);
    expect(reutilise).toBe("invalid_grant");
    expect((await etatTournant()).revoque).toBe(true);
    // La révocation emporte aussi le jeton neuf, comme chez les fournisseurs.
    expect(await appel(premier.refresh_token as string).then(() => "accepte", (e: unknown) => (e as ErreurFournisseur).kind)).toBe("invalid_grant");
  });

  it("[A-057] le renouvellement part avant l'expiration", async () => {
    const proche = monde({}, { expires_at: Math.floor(T0 / 1000) + 300 }); // 5 minutes
    await renouvelerSiBesoin(proche.p, CONN);
    expect(proche.etat.appels).toBe(1);
    const premierTiers = monde({}, { expires_at: Math.floor(T0 / 1000) + 1100, duree_s: 3600 }); // 18 min sur 60 : sous le tiers
    await renouvelerSiBesoin(premierTiers.p, CONN);
    expect(premierTiers.etat.appels).toBe(1);
    const loin = monde({}, { expires_at: Math.floor(T0 / 1000) + 3000, duree_s: 3600 });
    const r = await renouvelerSiBesoin(loin.p, CONN);
    expect(loin.etat.appels).toBe(0);
    expect(r.jetonAcces).toBe("ancien-acces");
  });

  it("[A-336] OpenBao indisponible après la réponse du fournisseur : aucun second appel au fournisseur", async () => {
    const w = monde({ ecrire: async () => { throw new Error(`coffre en panne ${NOUVEAU_RENOUVELLEMENT}`); } });
    const e = await erreur(renouvelerSiBesoin(w.p, CONN));
    expect(e).toBeInstanceOf(ErreurRenouvellement);
    expect(e?.code).toBe("ecriture_echouee");
    expect(w.etat.appels).toBe(1);
    expect(w.etat.averifier).toEqual([CONN.connexionId]);
    expect(w.etat.alertes).toEqual([`${CONN.connexionId}:ecriture_echouee`]);
    // Ensuite : la connexion « à vérifier » n'est plus renouvelée toute seule.
    expect((await erreur(renouvelerSiBesoin(w.p, CONN)))?.code).toBe("a_verifier");
    expect(w.etat.appels).toBe(1);
  });

  it("[A-336] une écriture qui échoue puis réussit est retentée sans second appel au fournisseur", async () => {
    let n = 0;
    const w = monde();
    const ecrire = w.p.ecrire;
    w.p.ecrire = async (c, s) => { if (++n < 3) throw new Error("coffre"); await ecrire(c, s); };
    const r = await renouvelerSiBesoin(w.p, CONN);
    expect(n).toBe(3);
    expect(w.etat.appels).toBe(1);
    expect(r.jetonAcces).toBe(NOUVEL_ACCES);
    expect(w.secret().refresh_token).toBe(NOUVEAU_RENOUVELLEMENT);
  });

  it("[A-057] invalid_grant : connexion rouge et instances en pause", async () => {
    const w = monde({ fournisseur: async () => { throw new ErreurFournisseur("invalid_grant"); } });
    expect((await erreur(renouvelerSiBesoin(w.p, CONN)))?.code).toBe("invalid_grant");
    expect(w.etat.rouges).toEqual([CONN.connexionId]);
    expect(w.etat.pauses).toEqual(CONN.instanceIds.map((i) => `${i}:identification`));
    expect((await erreur(renouvelerSiBesoin(w.p, CONN)))?.code).toBe("connexion_rouge");
  });

  it("[A-336] bail expiré pendant un appel lent : l'appel est abandonné avant l'échéance du bail, aucun second appel", async () => {
    const w = monde({
      fournisseur: (_j, signal) => new Promise((_ok, ko) => { signal?.addEventListener("abort", () => ko(new ErreurFournisseur("incertain"))); }),
    });
    w.etat.appels = 0;
    let appels = 0;
    const lent = w.p.fournisseur;
    w.p.fournisseur = (j, s) => { appels++; return lent(j, s); };
    w.p.delaiFournisseurMs = 20; // bien avant le bail de 3 s
    expect((await erreur(renouvelerSiBesoin(w.p, CONN)))?.code).toBe("reponse_incertaine");
    // Le bail finit : un second processus ne rappelle pas le fournisseur avec un jeton peut-être consommé.
    w.etat.horloge += 10_000;
    expect((await erreur(renouvelerSiBesoin(w.p, CONN)))?.code).toBe("a_verifier");
    expect(appels).toBe(1);
    expect(w.etat.averifier).toEqual([CONN.connexionId]);
  });

  it("[A-336] verrou perdu avant l'appel (deux processus qui se croient titulaires) : aucun appel au fournisseur", async () => {
    const base = creerVerrouMemoire(() => T0);
    const verrou: Verrou = { ...base, prolonger: async () => false };
    const w = monde({ verrou });
    expect((await erreur(renouvelerSiBesoin(w.p, CONN)))?.code).toBe("verrou_perdu");
    expect(w.etat.appels).toBe(0);
  });

  it("[A-336] celui qui prend le verrou après un autre revérifie le secret et ne renouvelle pas une seconde fois", async () => {
    const w = monde();
    await renouvelerSiBesoin(w.p, CONN);
    const w2 = { ...w.p, lire: async () => w.secret() };
    await renouvelerSiBesoin(w2, CONN);
    expect(w.etat.appels).toBe(1);
  });

  it("[A-336] aucune valeur de jeton dans le journal ni dans les erreurs", async () => {
    const pannes: ((w: ReturnType<typeof monde>) => Partial<PortsRenouvellement>)[] = [
      () => ({ ecrire: async () => { throw new Error(`secret ${NOUVEAU_RENOUVELLEMENT} ${NOUVEL_ACCES}`); } }),
      () => ({ fournisseur: async () => { throw Object.assign(new Error(`rejet ${ANCIEN_RENOUVELLEMENT}`), { kind: "refuse" }); } }),
      () => ({ lire: async () => { throw new Error(`lecture ${ANCIEN_RENOUVELLEMENT}`); } }),
    ];
    for (const panne of pannes) {
      const w = monde();
      Object.assign(w.p, panne(w));
      const e = await erreur(renouvelerSiBesoin(w.p, CONN));
      const vu = JSON.stringify([e?.message, e?.stack, e?.code, w.etat.lignes, w.etat.alertes]);
      for (const marqueur of [ANCIEN_RENOUVELLEMENT, NOUVEAU_RENOUVELLEMENT, NOUVEL_ACCES]) expect(vu).not.toContain(marqueur);
      expect(w.etat.lignes.length).toBeGreaterThan(0);
    }
  });

  it("[A-336] un refus net du fournisseur (jeton non consommé) libère le verrou : un nouvel essai est permis", async () => {
    let n = 0;
    const w = monde({ fournisseur: async () => { n++; if (n === 1) throw new ErreurFournisseur("refuse"); return { access_token: NOUVEL_ACCES, refresh_token: NOUVEAU_RENOUVELLEMENT, expires_in: 3600 }; } });
    expect((await erreur(renouvelerSiBesoin(w.p, CONN)))?.code).toBe("fournisseur_indisponible");
    expect((await renouvelerSiBesoin(w.p, CONN)).jetonAcces).toBe(NOUVEL_ACCES);
  });
});
