import { createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { exigerEquipeParRole } from "../../serveur.js";
import { routeStatut, type DepsStatut } from "./routes.js";
import { routeSonde, type DepsSonde } from "./sonde.js";
import type { Incident, MessageStatut } from "./page.js";

// T5-12b : page d'état publique, routes de gestion et signal de la sonde extérieure. Aucun Docker, aucun réseau.
const MAINTENANT = Date.parse("2026-11-08T10:00:00Z");
type Session = { equipe: boolean; role: string };

function monterStatut(session: Session, extra: { incidents?: Incident[]; ouvert?: boolean } = {}) {
  const app = Fastify();
  brancherErreurs(app);
  let message: MessageStatut | null = null;
  const d: DepsStatut = {
    ouvert: () => extra.ouvert ?? true,
    exigerEquipe: async function (this: FastifyInstance, requete, reponse) {
      await exigerEquipeParRole(async () => session).call(this, requete, reponse);
    },
    etatsBriques: async () => ({ api: "haut", console: "haut", portail: "haut", greenmail: "haut", "passerelle-ia": "bas", "wal-test-bertin": "bas" }),
    incidents: async () => extra.incidents ?? [],
    depot: { lire: async () => message, ecrire: async (m) => { message = m; } },
    maintenant: () => MAINTENANT,
  };
  routeStatut(app, d);
  return app;
}

describe("page d'état publique", () => {
  it("[B-405] la page publique répond sans authentification et ne contient aucun nom du jeu d'essai", async () => {
    const app = monterStatut({ equipe: false, role: "client" }, {
      incidents: [{ id: "i1", gravite: "critique", debut: "2026-11-08T09:30:00Z", composant: "Portail", titre: "Panne chez Atelier Bertin sur api.interne.test 10.0.0.12" }],
    });
    const r = await app.inject({ method: "GET", url: "/api/public/v1/statut" });
    expect(r.statusCode).toBe(200);
    const corps = r.body;
    for (const interdit of ["Atelier Bertin", "Lemoine", "Marceau", "Rivoire", "Garage Fontaine", "bertin", "interne.test", "10.0.0.12", "passerelle-ia", "wal-test"]) {
      expect(corps).not.toContain(interdit);
    }
    const noms = (r.json().composants as Array<{ nom: string }>).map((c) => c.nom).sort();
    expect(noms).toEqual(["Automatisations", "Console", "Messagerie", "Portail"]);
  });

  it("[B-405] un composant passe en panne si une de ses briques est à l'arrêt", async () => {
    const app = monterStatut({ equipe: false, role: "client" });
    const r = await app.inject({ method: "GET", url: "/api/public/v1/statut" });
    const etat = Object.fromEntries((r.json().composants as Array<{ nom: string; etat: string }>).map((c) => [c.nom, c.etat]));
    expect(etat["Console"]).toBe("operationnel");
    const arret = Fastify();
    brancherErreurs(arret);
    routeStatut(arret, { ...(monterDeps()), etatsBriques: async () => ({ api: "bas", console: "haut", portail: "haut", greenmail: "haut" }) });
    const r2 = await arret.inject({ method: "GET", url: "/api/public/v1/statut" });
    const etat2 = Object.fromEntries((r2.json().composants as Array<{ nom: string; etat: string }>).map((c) => [c.nom, c.etat]));
    expect(etat2["Automatisations"]).toBe("panne");
    expect(etat2["Console"]).toBe("operationnel");
  });

  it("[C-565] un incident ouvert apparaît sur la page avec son heure de début", async () => {
    const app = monterStatut({ equipe: false, role: "client" }, {
      incidents: [{ id: "i1", gravite: "majeure", debut: "2026-11-08T09:30:00Z", composant: "Portail", titre: "x" }],
    });
    const r = await app.inject({ method: "GET", url: "/api/public/v1/statut" });
    expect(r.json().incidents).toEqual([{ composant: "Portail", debut: "2026-11-08T09:30:00Z", gravite: "majeure" }]);
  });

  it("[B-016] PUT statut par l'équipe change la page ; par un client → 403", async () => {
    const equipe = monterStatut({ equipe: true, role: "dirigeant" });
    const ecrit = await equipe.inject({ method: "PUT", url: "/api/console/v1/statut", payload: { type: "maintenance", texte: "Maintenance ce soir à 22 h." } });
    expect(ecrit.statusCode).toBe(200);
    const lu = await equipe.inject({ method: "GET", url: "/api/public/v1/statut" });
    expect(lu.json().message).toEqual({ type: "maintenance", texte: "Maintenance ce soir à 22 h." });
    const client = monterStatut({ equipe: false, role: "client" });
    const refus = await client.inject({ method: "PUT", url: "/api/console/v1/statut", payload: { type: "incident", texte: "x" } });
    expect(refus.statusCode).toBe(403);
    expect((await client.inject({ method: "GET", url: "/api/console/v1/statut" })).statusCode).toBe(403);
  });

  it("[B-016] le message refuse une adresse IP, un nom d'hôte interne, un texte vide ou trop long, et la route est fermée par défaut", async () => {
    const app = monterStatut({ equipe: true, role: "dirigeant" });
    for (const texte of ["Panne sur 10.0.0.12", "Voir api.interne", "", "a".repeat(281)]) {
      const r = await app.inject({ method: "PUT", url: "/api/console/v1/statut", payload: { type: "incident", texte } });
      expect(r.statusCode).toBe(400);
    }
    const ferme = monterStatut({ equipe: true, role: "dirigeant" }, { ouvert: false });
    expect((await ferme.inject({ method: "GET", url: "/api/public/v1/statut" })).statusCode).toBe(503);
  });
});

function monterDeps(): DepsStatut {
  let message: MessageStatut | null = null;
  return {
    ouvert: () => true,
    exigerEquipe: (async () => undefined) as never,
    etatsBriques: async () => ({}),
    incidents: async () => [],
    depot: { lire: async () => message, ecrire: async (m) => { message = m; } },
    maintenant: () => MAINTENANT,
  };
}

const CLE = Buffer.from("cle-de-sonde-pour-essai-seulement");
const signer = (horodatage: string, corps: string, cle = CLE) => createHmac("sha256", cle).update(`${horodatage}.${corps}`).digest("hex");

function monterSonde(ouvert = true) {
  const app = Fastify();
  brancherErreurs(app);
  const incidents: unknown[] = [];
  const d: DepsSonde = {
    ouvert: () => ouvert,
    cles: async () => [{ secret: CLE }],
    ouvrirIncident: async (e) => { incidents.push(e); return { id: "inc-1", nouveau: true }; },
    maintenant: () => MAINTENANT,
  };
  routeSonde(app, d);
  return { app, incidents };
}
const CORPS = JSON.stringify({ etat: "injoignable" });
const hdr = (h: string, s: string) => ({ "content-type": "application/json", "x-axion-horodatage": h, "x-axion-signature": s });

describe("signal de la sonde extérieure", () => {
  it("[B-444] signal de sonde non signé → 401, signé → incident critique", async () => {
    const { app, incidents } = monterSonde();
    const h = String(Math.floor(MAINTENANT / 1000));
    const sans = await app.inject({ method: "POST", url: "/api/public/v1/sonde", payload: CORPS, headers: { "content-type": "application/json" } });
    expect(sans.statusCode).toBe(401);
    const faux = await app.inject({ method: "POST", url: "/api/public/v1/sonde", payload: CORPS, headers: hdr(h, signer(h, CORPS, Buffer.from("autre"))) });
    expect(faux.statusCode).toBe(401);
    expect(incidents).toHaveLength(0);
    const bon = await app.inject({ method: "POST", url: "/api/public/v1/sonde", payload: CORPS, headers: hdr(h, signer(h, CORPS)) });
    expect(bon.statusCode).toBe(200);
    expect(incidents).toEqual([{ type: "plateforme_injoignable", gravite: "critique", detecteLe: new Date(MAINTENANT).toISOString() }]);
  });

  it("[B-444] un signal trop ancien est refusé (rejeu) et un corps inattendu n'ouvre rien", async () => {
    const { app, incidents } = monterSonde();
    const vieux = String(Math.floor(MAINTENANT / 1000) - 600);
    const r = await app.inject({ method: "POST", url: "/api/public/v1/sonde", payload: CORPS, headers: hdr(vieux, signer(vieux, CORPS)) });
    expect(r.statusCode).toBe(401);
    const h = String(Math.floor(MAINTENANT / 1000));
    const autre = JSON.stringify({ etat: "ok" });
    const ok = await app.inject({ method: "POST", url: "/api/public/v1/sonde", payload: autre, headers: hdr(h, signer(h, autre)) });
    expect(ok.statusCode).toBe(200);
    expect(incidents).toHaveLength(0);
  });

  it("[B-444] la route de la sonde est fermée par défaut (503)", async () => {
    const { app, incidents } = monterSonde(false);
    const h = String(Math.floor(MAINTENANT / 1000));
    const r = await app.inject({ method: "POST", url: "/api/public/v1/sonde", payload: CORPS, headers: hdr(h, signer(h, CORPS)) });
    expect(r.statusCode).toBe(503);
    expect(incidents).toHaveLength(0);
  });
});
