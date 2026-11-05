import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../plugins/erreurs.js";
import { routeDonnees } from "./donnees.js";
import { creerServiceDonnees, type PortsDonnees, type SessionDonnees } from "../donnees/service.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
async function appli() {
  const vus: { session: SessionDonnees; nom: string; parametres: unknown }[] = [];
  const s = Fastify();
  brancherErreurs(s);
  const session: SessionDonnees = { tenantId: A, role: "client", acteur: "u1", etablissements: [] };
  routeDonnees(s, { session: async () => session, executer: async (se, nom, parametres) => { vus.push({ session: se, nom, parametres }); return [{ total: 1 }]; } });
  await s.ready();
  return { s, vus };
}

describe("route des données client", () => {
  it("[C-536] @isolation un client, un en-tête X-Tenant, un cookie ou un chemin de l'autre client sont ignorés : la session décide", async () => {
    const { s, vus } = await appli();
    const r = await s.inject({ method: "POST", url: `/api/v1/donnees/compterPersonnes?tenantId=${B}`, headers: { "x-tenant": B, cookie: `tenant=${B}` }, payload: { tenantId: B } });
    expect(r.statusCode).toBe(200);
    expect(vus[0]!.session.tenantId).toBe(A);
    expect(vus[0]!.parametres).toEqual({ tenantId: B });
  });

  it("[B-172] un nom de requête mal formé est refusé avant le service", async () => {
    const { s, vus } = await appli();
    expect((await s.inject({ method: "POST", url: "/api/v1/donnees/a%20b;drop", payload: {} })).statusCode).toBe(400);
    expect(vus).toEqual([]);
  });
});

// Niveau route, avec le vrai service et des ports en mémoire : la session décide, quoi que la requête nomme (preuves de T2-37b ; le détail du service est dans service.test.ts).
const ETAB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T0 = new Date("2026-11-02T10:00:00Z");
async function appliService(session: SessionDonnees, maintenant = T0) {
  const ouvertures: string[] = [];
  const requetes: { texte: string; valeurs: unknown[] }[] = [];
  const ports: PortsDonnees = {
    async base(tenantId) { return { nomBase: `cli_${tenantId.slice(0, 4)}`, etat: "active" }; },
    async ouvrir(nomBase) { ouvertures.push(nomBase); return { async requete(texte, valeurs) { requetes.push({ texte, valeurs }); return texte.includes("commun.etablissements") ? [{ id: ETAB_A }] : [{ total: 1 }]; }, async fermer() {} }; },
    accordValide: async () => true,
    // La vue rangée côté serveur est celle que la session réclame : ce fichier teste la route, la vérification de la copie est dans vue-serveur.test.ts.
    vueRangee: () => (session.vue ? { expireLe: session.vue.expireLe } : undefined),
    maintenant: () => maintenant,
  };
  const service = creerServiceDonnees(ports);
  const s = Fastify();
  brancherErreurs(s);
  routeDonnees(s, { session: async () => session, roleEquipe: async () => "administrateur", executer: (se, nom, p) => service.executer(se, nom, p) });
  await s.ready();
  const poster = (nom: string, payload: unknown = {}) => s.inject({ method: "POST", url: `/api/v1/donnees/${nom}?tenantId=${B}`, headers: { "x-tenant": B }, payload: payload as never });
  return { poster, ouvertures, requetes };
}
const clientA: SessionDonnees = { tenantId: A, role: "client", acteur: "u1", etablissements: [ETAB_A] };

describe("route des données client : la session décide", () => {
  it("[A-170] la route n'ouvre que la base de la session, même si la requête nomme un autre client", async () => {
    const { poster, ouvertures } = await appliService(clientA);
    expect((await poster("compterPersonnes", { tenantId: B })).statusCode).toBe(200);
    expect(ouvertures).toEqual(["cli_1111"]);
  });

  it("[B-172] la route refuse un nom hors liste blanche sans ouvrir de base", async () => {
    const { poster, ouvertures } = await appliService(clientA);
    expect((await poster("supprimerTout")).statusCode).toBe(400);
    expect(ouvertures).toEqual([]);
  });

  it("[B-173] @isolation un établissement nommé dans le corps ne remplace pas ceux de la session", async () => {
    const { poster, requetes } = await appliService(clientA);
    await poster("compterPersonnes", { etablissements: [ETAB_B], etablissement_id: ETAB_B });
    expect(requetes.at(-1)?.valeurs).toEqual([[ETAB_A]]);
  });

  it("[B-070] @isolation l'équipe sans vue ne lit pas le contenu : 403, aucune requête envoyée", async () => {
    const { poster, requetes } = await appliService({ tenantId: B, role: "equipe", acteur: "e1", etablissements: [] });
    expect((await poster("listerListesProspects")).statusCode).toBe(403);
    expect(requetes).toEqual([]);
  });

  it("[C-006] @isolation une vue ouverte pour un autre client n'ouvre pas le contenu de celui de la session", async () => {
    const { poster, requetes } = await appliService({ tenantId: B, role: "equipe", acteur: "e1", etablissements: [], vue: { tenantId: A, expireLe: new Date(T0.getTime() + 3_600_000) } });
    expect((await poster("listerListesProspects")).statusCode).toBe(403);
    expect(requetes).toEqual([]);
  });

  it("[A-005] @isolation la vue « comme le client » est refusée dès son expiration", async () => {
    const vue = { tenantId: B, expireLe: new Date(T0.getTime() + 60 * 60_000) };
    const session: SessionDonnees = { tenantId: B, role: "equipe", acteur: "e1", etablissements: [], vue };
    expect((await (await appliService(session, new Date(T0.getTime() + 59 * 60_000))).poster("listerListesProspects")).statusCode).toBe(200);
    expect((await (await appliService(session, new Date(T0.getTime() + 61 * 60_000))).poster("listerListesProspects")).statusCode).toBe(403);
  });
});

// Contrôle d'équipe (T2-37c, étape 3) : un client passe ; une session d'équipe passe sauf lecteur et qualifieur ; sans rôle d'équipe lisible, tout est refusé.
describe("route des données : équipe", () => {
  const SESSION_EQUIPE: SessionDonnees = { tenantId: A, role: "equipe", acteur: "e1", etablissements: [] };
  async function avec(session: SessionDonnees, roleEquipe?: string, fournir = true) {
    const vus: string[] = [];
    const s = Fastify();
    brancherErreurs(s);
    routeDonnees(s, { session: async () => session, ...(fournir ? { roleEquipe: async () => roleEquipe } : {}), executer: async (_se, nom) => { vus.push(nom); return []; } });
    await s.ready();
    return { s, vus };
  }
  it("[B-070] @isolation les rôles lecteur et qualifieur de l'équipe sont refusés avant le service", async () => {
    for (const r of ["lecteur", "qualifieur"]) {
      const { s, vus } = await avec(SESSION_EQUIPE, r);
      expect((await s.inject({ method: "POST", url: "/api/v1/donnees/compterPersonnes", payload: {} })).statusCode, r).toBe(403);
      expect(vus).toEqual([]);
    }
  });
  it("[B-070] @isolation une session d'équipe sans rôle lisible, ou sans fonction de rôle, est refusée", async () => {
    expect((await (await avec(SESSION_EQUIPE, undefined)).s.inject({ method: "POST", url: "/api/v1/donnees/compterPersonnes", payload: {} })).statusCode).toBe(403);
    expect((await (await avec(SESSION_EQUIPE, "admin", false)).s.inject({ method: "POST", url: "/api/v1/donnees/compterPersonnes", payload: {} })).statusCode).toBe(403);
  });
  it("[B-070] @isolation par défaut refus : un rôle d'équipe inconnu (admin, vide, autre casse) est refusé avant le service", async () => {
    for (const r of ["admin", "", "Administrateur", "root"]) {
      const { s, vus } = await avec(SESSION_EQUIPE, r);
      expect((await s.inject({ method: "POST", url: "/api/v1/donnees/compterPersonnes", payload: {} })).statusCode, r).toBe(403);
      expect(vus).toEqual([]);
    }
  });
  it("[B-070] un rôle d'équipe autre (administrateur) passe, et un client n'a pas besoin de rôle d'équipe", async () => {
    const a = await avec(SESSION_EQUIPE, "administrateur");
    expect((await a.s.inject({ method: "POST", url: "/api/v1/donnees/compterPersonnes", payload: {} })).statusCode).toBe(200);
    const c = await avec({ tenantId: A, role: "client", acteur: "u1", etablissements: [] }, undefined, false);
    expect((await c.s.inject({ method: "POST", url: "/api/v1/donnees/compterPersonnes", payload: {} })).statusCode).toBe(200);
  });
});
