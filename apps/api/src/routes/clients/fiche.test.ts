import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { routeFiche, type DepsFiche, type FicheBrute } from "./fiche.js";

// Fiche client 360° (T3-13) : le client de l'URL doit être dans la portée de la session, sinon 404 identique à un client absent.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const brute: FicheBrute & { contenu_message: string } = {
  nom: "Lemoine Rénovation",
  etat: "a_aider",
  formule: "Standard",
  derniere_erreur: { code: "connexion_expiree", message: "La connexion a expiré.", contenu_message: "texte privé" } as never,
  connexions: { total: 2, a_reprendre: 1 },
  prochaine_echeance: "2026-11-12",
  abonnement: { formule: "Standard", engagement: "12 mois" },
  automatisations_actives: 2,
  reglages: { versions: 3 },
  executions: { reussies_pourcent: 98.7, en_attente: 142 },
  notes: { total: 4, epinglees: 1 },
  factures: { en_attente: 0 },
  contenu_message: "ne doit jamais sortir",
};
function serveur(o: { ouvert?: boolean; voit?: string[] } = {}) {
  const lectures: string[] = [];
  const app = Fastify();
  brancherErreurs(app);
  const deps: DepsFiche = {
    ouvert: () => o.ouvert ?? true,
    exigerEquipe: (async () => undefined) as never,
    session: async () => ({ acteur: "agent-essai", peutVoir: (id: string) => (o.voit ?? [A]).includes(id) }),
    async lire(id) { lectures.push(id); return brute; },
  };
  routeFiche(app, deps);
  return { app, lectures };
}
const url = (id: string) => `/api/console/v1/clients/${id}/fiche`;

describe("route de la fiche client", () => {
  it("[B-100] le bandeau montre la dernière erreur (code et message) et l'état des connexions, jamais de contenu", async () => {
    const { app } = serveur();
    const rep = await app.inject({ method: "GET", url: url(A) });
    expect(rep.statusCode).toBe(200);
    const { bandeau } = rep.json();
    expect(bandeau.derniere_erreur).toEqual({ code: "connexion_expiree", message: "La connexion a expiré." });
    expect(bandeau.connexions).toEqual({ total: 2, a_reprendre: 1 });
    expect(JSON.stringify(rep.json())).not.toMatch(/texte privé|ne doit jamais sortir/);
  });

  it("[B-036] le résumé donne abonnement, automatisations, réglages, connexions, exécutions, notes et factures", async () => {
    const { app } = serveur();
    const { resume } = (await app.inject({ method: "GET", url: url(A) })).json();
    expect(Object.keys(resume).sort()).toEqual(["abonnement", "automatisations_actives", "connexions", "executions", "factures", "notes", "reglages"]);
    expect(resume.automatisations_actives).toBe(2);
  });

  it("[B-126] @isolation une fiche hors portée répond 404 sans lire le client", async () => {
    const { app, lectures } = serveur();
    const hors = await app.inject({ method: "GET", url: url(B) });
    const absent = await app.inject({ method: "GET", url: url("33333333-3333-4333-8333-333333333333") });
    expect(hors.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect({ ...hors.json(), erreur: { ...hors.json().erreur, id_trace: "x" } }).toEqual({ ...absent.json(), erreur: { ...absent.json().erreur, id_trace: "x" } });
    expect(lectures).toEqual([]);
  });

  it("[B-126] un identifiant qui n'est pas un UUID est refusé (400) sans lecture", async () => {
    const { app, lectures } = serveur();
    expect((await app.inject({ method: "GET", url: url("pas-un-uuid") })).statusCode).toBe(400);
    expect(lectures).toEqual([]);
  });

  it("[B-035] l'interrupteur de la fiche est fermé par défaut : 503 et aucune lecture", async () => {
    const { app, lectures } = serveur({ ouvert: false });
    expect((await app.inject({ method: "GET", url: url(A) })).statusCode).toBe(503);
    expect(lectures).toEqual([]);
  });
});
