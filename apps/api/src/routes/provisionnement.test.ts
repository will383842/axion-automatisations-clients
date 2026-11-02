import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs, ErreurApi } from "../plugins/erreurs.js";
import { routeProvisionnement } from "./provisionnement.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
function serveur(etat: string | null = "en_creation", equipe = true) {
  const app = Fastify();
  brancherErreurs(app);
  const deposes: string[] = [];
  const exigerEquipe = async () => { if (!equipe) throw new ErreurApi("action_interdite", "Réservé à l'équipe."); };
  routeProvisionnement(app, { exigerEquipe: exigerEquipe as never, etatBase: async () => etat ?? undefined, reprendre: async (t) => void deposes.push(t) });
  return { app, deposes };
}
const url = (c = CLIENT) => `/api/console/v1/clients/${c}/base/reprendre`;

describe("reprise manuelle du provisionnement", () => {
  it("[A-224] l'équipe reprend une base en_creation : une tâche est redéposée", async () => {
    const s = serveur();
    expect((await s.app.inject({ method: "POST", url: url() })).statusCode).toBe(202);
    expect(s.deposes).toEqual([CLIENT]);
  });

  it("[A-224] @isolation un rôle autre que l'équipe, une base active, une base absente ou un identifiant piégé : refus, rien n'est déposé", async () => {
    const hors = serveur("en_creation", false);
    expect((await hors.app.inject({ method: "POST", url: url() })).statusCode).toBe(403);
    const active = serveur("active");
    expect((await active.app.inject({ method: "POST", url: url() })).statusCode).toBe(403);
    const absente = serveur(null);
    expect((await absente.app.inject({ method: "POST", url: url() })).statusCode).toBe(404);
    const piege = serveur();
    expect((await piege.app.inject({ method: "POST", url: url("x'--") })).statusCode).toBe(400);
    expect([hors, active, absente, piege].flatMap((s) => s.deposes)).toEqual([]);
  });
});
