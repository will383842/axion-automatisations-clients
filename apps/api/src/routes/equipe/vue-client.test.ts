import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { envoisServiceEnMemoire } from "../../envois/service.js";
import { creerServiceDonnees, type PortsDonnees } from "../../donnees/service.js";
import { brancherGardeLectureSeule } from "../../vue-client/garde-lecture-seule.js";
import { creerRegistreVues } from "../../vue-client/ouvrir.js";
import type { EntreeTrace } from "../../vue-client/trace.js";
import { routeVueClient } from "./vue-client.js";

// Routes de la vue « comme le client » (T3-08a) : garde posée en premier, horloge injectée, dépôts en mémoire.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ABSENT = "33333333-3333-4333-8333-333333333333";
const T0 = new Date("2026-11-07T10:00:00Z");
const BASE = (id: string) => `/api/console/v1/clients/${id}/vue-client`;
const COOKIE = { cookie: "sid=e1" };

async function monde(o: { panneTrace?: boolean; accord?: (id: string) => boolean } = {}) {
  let t = T0.getTime();
  const maintenant = () => new Date(t);
  const registre = creerRegistreVues(maintenant);
  const envois = envoisServiceEnMemoire();
  const traces: EntreeTrace[] = [];
  const etat = { panneTrace: o.panneTrace ?? false, ordinaire: 0 };
  const equipe = async (req: FastifyRequest) => (/sid=e1/.test(String(req.headers.cookie ?? "")) ? { acteur: "e1", roleEquipe: "administrateur" } : undefined);
  const s = Fastify();
  brancherErreurs(s);
  const deps = {
    garde: { registre, acteur: async (req: FastifyRequest) => (await equipe(req))?.acteur },
    exigerDroit: async (req: FastifyRequest) => { if (!(await equipe(req))) throw Object.assign(new Error("refus"), { statusCode: 403 }); },
    equipe,
    vue: { accordValide: async (id: string) => (o.accord ?? (() => true))(id), finIntervention: async () => new Date(t + 7_200_000) },
    maintenant, envois,
    trace: { ecrire: async (e: EntreeTrace) => { if (etat.panneTrace) throw new Error("base"); traces.push(e); } },
  };
  brancherGardeLectureSeule(s, deps.garde);
  routeVueClient(s, deps as never);
  s.get("/api/console/v1/ordinaire", async () => { etat.ordinaire++; return { ok: true }; });
  await s.ready();
  const ports: PortsDonnees = {
    base: async () => ({ nomBase: "cli_1111", etat: "active" }),
    ouvrir: async () => ({ requete: async () => [{ id: "x", nom: "Liste", cree_le: "t" }], fermer: async () => {} }),
    accordValide: async () => true,
    vueRangee: (acteur, tenantId) => registre.vueRangee(acteur, tenantId),
    maintenant,
  };
  const sans = (r: { json(): unknown }) => { const c = r.json() as { erreur?: { id_trace?: string } }; if (c.erreur) delete c.erreur.id_trace; return c; };
  return {
    s, registre, envois, traces, etat, service: creerServiceDonnees(ports), sans, avancer: (ms: number) => { t += ms; },
    ouvrir: (id = A, motif = "assistance") => s.inject({ method: "POST", url: BASE(id), headers: COOKIE, payload: { motif } }),
    page: (id: string, page: string) => s.inject({ method: "POST", url: `${BASE(id)}/pages`, headers: COOKIE, payload: { page } }),
  };
}

describe("routes de la vue « comme le client »", () => {
  it("[C-007] @isolation vue ouverte sur A : une ressource de B répond comme une ressource absente", async () => {
    const m = await monde();
    expect((await m.ouvrir()).statusCode).toBe(201);
    const avant = m.traces.length;
    const deB = await m.page(B, "fiche");
    const absent = await m.page(ABSENT, "fiche");
    expect(deB.statusCode).toBe(404);
    expect([deB.statusCode, m.sans(deB)]).toEqual([absent.statusCode, m.sans(absent)]);
    expect(m.traces).toHaveLength(avant);
    // Le service des données refuse aussi le contenu de B : la vue rangée est celle de A seulement.
    const session = { tenantId: B, role: "equipe" as const, acteur: "e1", etablissements: [], vue: { tenantId: B, expireLe: new Date(T0.getTime() + 600_000) } };
    expect(((await m.service.executer(session, "listerListesProspects", {}).catch((e: unknown) => e)) as { code: string }).code).toBe("action_interdite");
  });

  it("[C-008] @isolation à la 61e minute, la vue est fermée côté serveur", async () => {
    const m = await monde();
    await m.ouvrir();
    const session = { tenantId: A, role: "equipe" as const, acteur: "e1", etablissements: [], vue: { tenantId: A, expireLe: new Date(T0.getTime() + 3_600_000) } };
    m.avancer(3_599_000);
    expect((await m.page(A, "fiche")).statusCode).toBe(200);
    expect(await m.service.executer(session, "listerListesProspects", {})).toHaveLength(1);
    expect((await m.s.inject({ method: "GET", url: "/api/console/v1/ordinaire", headers: COOKIE })).statusCode).toBe(403);
    // À 60:00 pile : la vue est finie. La page, le service et la garde le disent d'une seule voix.
    m.avancer(1_000);
    expect((await m.page(A, "fiche")).statusCode).toBe(404);
    expect(((await m.service.executer(session, "listerListesProspects", {}).catch((e: unknown) => e)) as { code: string }).code).toBe("action_interdite");
    expect((await m.s.inject({ method: "GET", url: "/api/console/v1/ordinaire", headers: COOKIE })).statusCode).toBe(200);
    // Rouvrir demande un nouveau geste : nouvelle ouverture, nouvel avis.
    expect((await m.ouvrir()).statusCode).toBe(201);
    expect(m.envois.deposes).toHaveLength(2);
  });

  it("[B-066] une 2e ouverture pendant la vue est refusée par la garde ; la route seule la refuse en 422", async () => {
    const m = await monde();
    await m.ouvrir();
    expect((await m.ouvrir()).statusCode).toBe(403);
    const sansGarde = Fastify();
    brancherErreurs(sansGarde);
    const reg = m.registre;
    routeVueClient(sansGarde, { garde: { registre: reg, acteur: async () => "e1" }, exigerDroit: async () => {}, equipe: async () => ({ acteur: "e1", roleEquipe: "administrateur" }), vue: { accordValide: async () => true, finIntervention: async () => new Date(T0.getTime() + 7_200_000) }, maintenant: () => T0, envois: m.envois, trace: { ecrire: async () => {} } } as never);
    expect((await sansGarde.inject({ method: "POST", url: BASE(A), payload: { motif: "assistance" } })).statusCode).toBe(422);
  });

  it("[C-009] chaque page consultée est tracée et le client est prévenu", async () => {
    const m = await monde();
    await m.ouvrir();
    expect(m.envois.deposes.map((d) => d.type)).toEqual(["avis_vue_client_ouverte"]);
    for (const page of ["fiche", "personnes", "fichiers"]) expect((await m.page(A, page)).statusCode).toBe(200);
    expect(m.traces.filter((x) => x.evenement === "page_consultee").map((x) => [x.acteur, x.tenantId, x.page, x.le])).toEqual(["fiche", "personnes", "fichiers"].map((p) => ["e1", A, p, T0]));
    // Un code de page qui n'en est pas un : 400, aucune trace.
    const n = m.traces.length;
    expect((await m.page(A, "https://x.test/a")).statusCode).toBe(400);
    expect((await m.s.inject({ method: "POST", url: `${BASE(A)}/pages`, headers: COOKIE, payload: { page: "fiche", client: B } })).statusCode).toBe(400);
    expect(m.traces).toHaveLength(n);
    // Trace en panne : pas de page.
    m.etat.panneTrace = true;
    expect((await m.page(A, "fiche")).statusCode).toBe(500);
  });

  it("[C-009] fermer la vue la retire et la trace ; l'état de la vue se lit sans effet de bord", async () => {
    const m = await monde();
    await m.ouvrir();
    const etat = await m.s.inject({ method: "GET", url: BASE(A), headers: COOKIE });
    expect(etat.json()).toMatchObject({ ouverte: true, expire_le: new Date(T0.getTime() + 3_600_000).toISOString() });
    expect((await m.s.inject({ method: "POST", url: `${BASE(A)}/fermer`, headers: COOKIE, payload: {} })).statusCode).toBe(200);
    expect(m.registre.vueDe("e1")).toBeUndefined();
    expect(m.traces.at(-1)?.evenement).toBe("vue_client_fermee");
    expect((await m.s.inject({ method: "GET", url: BASE(A), headers: COOKIE })).statusCode).toBe(404);
  });

  it("[B-420] la demande d'accord écrit part au client, une fois par jour, sans écrire d'accord", async () => {
    const m = await monde();
    const envoi = () => m.s.inject({ method: "POST", url: `${BASE(A)}/demande-accord`, headers: COOKIE, payload: {} });
    expect((await envoi()).statusCode).toBe(202);
    expect((await envoi()).statusCode).toBe(202);
    expect(m.envois.deposes).toHaveLength(1);
    expect(m.envois.deposes[0]).toMatchObject({ type: "demande_accord_vue_client", clientId: A });
    expect(m.traces.map((x) => x.evenement)).toEqual(["demande_accord_envoyee", "demande_accord_envoyee"]);
    const dossier = new URL("../../vue-client/", import.meta.url);
    const { readFileSync, readdirSync } = await import("node:fs");
    for (const f of readdirSync(dossier).filter((n) => !n.includes(".test."))) expect(readFileSync(new URL(f, dossier), "utf8"), f).not.toContain("visibilite_acces");
  });
});
