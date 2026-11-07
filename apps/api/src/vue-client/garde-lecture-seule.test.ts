import { readFileSync } from "node:fs";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../plugins/erreurs.js";
import { routeATrancher } from "../routes/a-trancher.js";
import { routeCanaux } from "../routes/canaux.js";
import { routeDonnees } from "../routes/donnees.js";
import { routeFiche } from "../routes/clients/fiche.js";
import { routeNotes } from "../routes/clients/notes.js";
import { routeGel } from "../routes/gel.js";
import { routeImport } from "../routes/import.js";
import { routeAnnulation, routeJournal } from "../routes/journal.js";
import { routeProvisionnement } from "../routes/provisionnement.js";
import { routeReglages } from "../routes/reglages.js";
import { routeVueClient } from "../routes/equipe/vue-client.js";
import { brancherGardeLectureSeule, PERMISES_EN_VUE } from "./garde-lecture-seule.js";
import { creerRegistreVues } from "./ouvrir.js";

// Lecture seule imposée par le serveur (B-067) : crochet racine posé AVANT toute route, liste blanche fermée, route identifiée par son motif.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-11-07T10:00:00Z");
let appels = 0;
// Dépendance vide : tout appel (même profond) est compté ; « then » reste indéfini pour qu'un await ne la prenne pas pour une promesse.
const espion = (): never => new Proxy(function () {} as object, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
const passe = (async () => { appels++; }) as never;

async function monde() {
  let t = T0.getTime();
  const registre = creerRegistreVues(() => new Date(t));
  const s = Fastify();
  const routes: { methode: string; url: string }[] = [];
  s.addHook("onRoute", (r) => { for (const m of [r.method].flat()) if (m !== "HEAD" && m !== "OPTIONS") routes.push({ methode: m, url: r.url }); });
  brancherErreurs(s);
  // La garde est posée EN PREMIER ; l'acteur vient de la session (cookie), jamais d'un en-tête libre.
  const acteur = async (req: FastifyRequest) => /sid=(e\d)/.exec(String(req.headers.cookie ?? ""))?.[1];
  brancherGardeLectureSeule(s, { registre, acteur });
  const o = { exigerEquipe: passe };
  routeVueClient(s, { garde: { registre, acteur }, exigerDroit: passe, equipe: async (r: FastifyRequest) => ({ acteur: (await acteur(r))!, roleEquipe: "administrateur" }), vue: { accordValide: async () => true, finIntervention: async () => new Date(t + 7_200_000) }, maintenant: () => new Date(t), envois: espion(), trace: { ecrire: async () => undefined } } as never);
  routeDonnees(s, { session: espion(), executer: espion() });
  routeGel(s, { ...o, exigerReauthentification: passe, session: espion(), gel: espion() });
  routeATrancher(s, { ...o, appelant: espion(), reauthentifie: espion(), appliquer: espion(), ecarter: espion() });
  routeCanaux(s, { ...o, magasin: espion() });
  routeJournal(s, { ...o, lire: espion() });
  routeAnnulation(s, { ...o, contexte: espion(), annuler: espion() });
  routeProvisionnement(s, { ...o, etatBase: espion(), reprendre: espion() });
  routeReglages(s, { ...o, contexte: espion(), historique: espion(), modifier: espion(), revenir: espion() });
  routeNotes(s, { ouvert: () => true, ...o, session: espion(), lister: espion(), ajouter: espion(), epingler: espion(), noterAppelEtClore: espion() });
  routeFiche(s, { ouvert: () => true, ...o, session: espion(), lire: espion() });
  routeImport(s, { ouvert: true, session: espion(), ports: espion() });
  // Une route enregistrée APRÈS la garde et après les autres : elle est couverte d'office (export, réglage ou domaine futur).
  s.post("/api/console/v1/clients/:id/export-futur", async () => { appels++; return { ok: true }; });
  s.get("/equipe/export-csv", async () => { appels++; return { ok: true }; });
  await s.ready();
  const jouer = (methode: string, url: string, sid?: string) => s.inject({ method: methode as "GET", url, headers: sid ? { cookie: `sid=${sid}` } : {}, ...(methode === "POST" ? { payload: {} } : {}) });
  return { s, registre, routes, jouer, avancer: (ms: number) => { t += ms; }, ouvrirVue: (acteurVue = "e1", client = A) => registre.ranger({ acteur: acteurVue, tenantId: client, expireLe: new Date(t + 3_600_000) }) };
}
const remplir = (url: string) => url.replace(/:[A-Za-z]+/g, B);

describe("garde de lecture seule", () => {
  it("[B-067] @isolation pendant la vue, toute écriture et tout export sont refusés", async () => {
    expect([...PERMISES_EN_VUE].sort()).toEqual([
      "GET /api/console/v1/clients/:id/vue-client",
      "POST /api/console/v1/clients/:id/vue-client/fermer",
      "POST /api/console/v1/clients/:id/vue-client/pages",
      "POST /api/v1/donnees/:nom",
    ]);
    const m = await monde();
    m.ouvrirVue();
    const bloquees = m.routes.filter((r) => !(PERMISES_EN_VUE as readonly string[]).includes(`${r.methode} ${r.url}`));
    expect(bloquees.length).toBeGreaterThan(15);
    expect(bloquees.map((r) => `${r.methode} ${r.url}`)).toEqual(expect.arrayContaining(["GET /equipe/journal", "GET /equipe/export-csv", "POST /api/console/v1/clients/:id/export-futur", "POST /api/console/v1/clients/:id/vue-client", "POST /api/console/v1/clients/:id/vue-client/demande-accord"]));
    for (const r of bloquees) {
      const avant = appels;
      const rep = await m.jouer(r.methode, remplir(r.url), "e1");
      expect(rep.statusCode, `${r.methode} ${r.url}`).toBe(403);
      expect((rep.json() as { erreur: { code: string } }).erreur.code).toBe("action_interdite");
      expect(appels - avant, `${r.methode} ${r.url} : aucune dépendance appelée`).toBe(0);
    }
    // Chemin inconnu, autre casse, double barre : jamais lus comme l'adresse brute, refus aussi.
    for (const url of ["/inconnu", "/API/console/v1/clients/x/gel", "//api/console/v1/clients/x/gel", "/equipe/journal;x=1"]) expect((await m.jouer("GET", url, "e1")).statusCode, url).toBe(403);
    // Sans vue (autre acteur, ou aucune session), les routes ordinaires restent joignables.
    const avant = appels;
    expect((await m.jouer("GET", "/equipe/export-csv", "e2")).statusCode).toBe(200);
    expect((await m.jouer("GET", "/equipe/export-csv")).statusCode).toBe(200);
    expect(appels - avant).toBe(2);
  });

  it("[B-067] @isolation la garde se lève à la fin de la vue, et ne laisse passer que le client de la vue", async () => {
    const m = await monde();
    m.ouvrirVue();
    expect((await m.jouer("POST", `/api/console/v1/clients/${B}/vue-client/pages`, "e1")).statusCode).toBe(404);
    expect((await m.jouer("GET", `/api/console/v1/clients/${B}/vue-client`, "e1")).statusCode).toBe(404);
    expect((await m.jouer("POST", `/api/console/v1/clients/${A}/vue-client/fermer`, "e1")).statusCode).toBe(200);
    expect((await m.jouer("GET", "/equipe/export-csv", "e1")).statusCode).toBe(200);
    m.ouvrirVue();
    m.avancer(3_600_000);
    expect((await m.jouer("GET", "/equipe/export-csv", "e1")).statusCode).toBe(200);
  });

  it("[B-067] @isolation un acteur illisible ou une panne de lecture de la session ne bloque pas les crochets de la route", async () => {
    const s = Fastify();
    brancherErreurs(s);
    const registre = creerRegistreVues(() => T0);
    registre.ranger({ acteur: "e1", tenantId: A, expireLe: new Date(T0.getTime() + 60_000) });
    brancherGardeLectureSeule(s, { registre, acteur: async () => { throw new ErreurApi("erreur_interne", "x"); } });
    s.get("/x", async () => ({ ok: true }));
    await s.ready();
    expect((await s.inject({ method: "GET", url: "/x" })).statusCode).toBe(200);
  });

  it("[B-067] @isolation serveur.ts pose la garde avant toute route, juste après la base", () => {
    const src = readFileSync(new URL("../serveur.ts", import.meta.url), "utf8");
    const garde = src.indexOf("brancherGardeLectureSeule(serveur");
    expect(garde).toBeGreaterThan(src.indexOf("brancherBase(serveur"));
    expect(garde).toBeLessThan(src.indexOf("routeSante(serveur"));
    expect(garde).toBeLessThan(src.indexOf("routeProvisionnement(serveur"));
    expect(garde).toBeLessThan(src.indexOf("routeDonnees(serveur"));
  });
});
