import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../plugins/erreurs.js";
import { routeFileAlertes, type DepsFileAlertes, type LigneAlerte } from "./routes.js";
import { ErreurCycle, type DepotCycle } from "./cycle.js";
import type { DepsDroits, MembreDroits } from "../../droits/exiger-droit.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
// Membres de la matrice (T3-06) : le rôle « lecteur » n'y existe pas. Le second administrateur est limité au client A (T1).
const MEMBRES: Record<string, MembreDroits> = {
  equipe: { sujet: "membre-1", role: "dirigeant", actif: true, portee: { clients: [], automatisations: [] } },
  second_a: { sujet: "membre-2", role: "second_administrateur", actif: true, portee: { clients: [T1], automatisations: [] } },
};
const refusTraces: string[] = [];
const droits: DepsDroits = {
  async membre(r) { return MEMBRES[String(r.headers["x-essai"] ?? "")]; },
  async absenceOuverte() { return false; },
  async tracer(e) { refusTraces.push(`${e.action}:${e.motif}`); },
};

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SESSIONS: Record<string, { acteur: string; role: string }> = {
  equipe: { acteur: "membre-1", role: "dirigeant" },
  second_a: { acteur: "membre-2", role: "second_administrateur" },
  inconnu: { acteur: "membre-3", role: "lecteur" },
  client: { acteur: "client-1", role: "client" },
};

// Fausse lecture : même ordre que la base (cree_le, tenant_id, id croissants), même filtres, curseur « strictement après ».
function lectureEnMemoire(lignes: (LigneAlerte & { tenant: string })[]) {
  return {
    async liste(f: { gravite?: string; client?: string; responsable?: string; etat?: string; limite: number; curseur?: { creeLe: string; tenantId: string; id: string } }) {
      const cle = (l: LigneAlerte & { tenant: string }) => `${l.cree_le}|${l.tenant}|${l.id}`;
      return lignes
        .filter((l) => (!f.gravite || l.gravite === f.gravite) && (!f.client || l.tenant === f.client) && (!f.responsable || l.responsable === f.responsable) && (!f.etat || l.etat === f.etat))
        .filter((l) => !f.curseur || cle(l) > `${f.curseur.creeLe}|${f.curseur.tenantId}|${f.curseur.id}`)
        .sort((a, b) => (cle(a) < cle(b) ? -1 : 1))
        .slice(0, f.limite);
    },
    async tenantDe(alerteId: string) {
      return lignes.find((l) => l.id === alerteId)?.tenant ?? null;
    },
  };
}
const ligne = (n: number, o: Partial<LigneAlerte & { tenant: string }> = {}): LigneAlerte & { tenant: string } => ({
  id: id(n), tenant: T1, client: T1, type: "connexion_expiree", gravite: "avertissement", cause: "timeout", responsable: null, etat: "ouverte",
  cree_le: new Date(Date.UTC(2026, 10, 1, n)).toISOString(), occurrences: 1, ...o,
});

let appels: string[];
let appli: FastifyInstance;
async function monter(ouvert = true, lignes = [ligne(1), ligne(2, { gravite: "critique" }), ligne(3, { tenant: T2, client: T2, responsable: "membre-1" })]) {
  appels = [];
  const cycle: DepotCycle = {
    async retablir() { return null; },
    async attribuer(t, a, ac) { appels.push(`attribuer:${t}:${a}:${ac}`); return true; },
    async commenter(t, a, texte, ac) { appels.push(`commenter:${t}:${a}:${ac}:${texte.length}`); },
    async clore(t, a, raison, ac) { appels.push(`clore:${t}:${a}:${raison}:${ac}`); return lignes.find((l) => l.id === a)?.etat !== "close"; }, // comme la base : rien n'est écrit sur une alerte déjà close
  };
  const deps: DepsFileAlertes = {
    ouvert,
    async authentifier(r: FastifyRequest) {
      const s = SESSIONS[String(r.headers["x-essai"] ?? "")];
      if (!s || s.role === "client") throw new ErreurApi("action_interdite", "Action interdite.");
      return s;
    },
    droits,
    lire: lectureEnMemoire(lignes),
    cycle,
    regles: {
      async regler(rid, patch, acteur) {
        appels.push(`regler:${rid}:${JSON.stringify(patch)}:${acteur}`);
        return rid === id(900) ? { id: rid, code: "sante_orange", gravite: "avertissement", seuil: 1, fenetre_s: 60, active: true } : null;
      },
    },
  };
  appli = Fastify();
  brancherErreurs(appli);
  routeFileAlertes(appli, deps);
  await appli.ready();
}
const h = (qui: string) => ({ "x-essai": qui });
beforeEach(() => monter());

describe("file d'alertes : routes d'équipe (T5-04c)", () => {
  it("[B-030] la liste filtre par gravité et trie par ancienneté", async () => {
    const tout = (await appli.inject({ method: "GET", url: "/api/console/v1/alertes", headers: h("equipe") })).json();
    expect(tout.alertes.map((a: LigneAlerte) => a.id)).toEqual([id(1), id(2), id(3)]);
    const crit = (await appli.inject({ method: "GET", url: "/api/console/v1/alertes?gravite=critique", headers: h("equipe") })).json();
    expect(crit.alertes.map((a: LigneAlerte) => a.id)).toEqual([id(2)]);
  });

  it("[B-030] la liste filtre par client, par responsable et pagine par curseur (cree_le, tenant_id, id) sans doublon ni trou", async () => {
    const parClient = (await appli.inject({ method: "GET", url: `/api/console/v1/alertes?client=${T2}`, headers: h("equipe") })).json();
    expect(parClient.alertes.map((a: LigneAlerte) => a.id)).toEqual([id(3)]);
    const parResp = (await appli.inject({ method: "GET", url: "/api/console/v1/alertes?responsable=membre-1", headers: h("equipe") })).json();
    expect(parResp.alertes.map((a: LigneAlerte) => a.id)).toEqual([id(3)]);
    const vues: string[] = [];
    let curseur: string | null = null;
    for (let tour = 0; tour < 5; tour++) {
      const r: { alertes: LigneAlerte[]; curseur_suivant: string | null } = (await appli.inject({ method: "GET", url: `/api/console/v1/alertes?limite=1${curseur ? `&curseur=${curseur}` : ""}`, headers: h("equipe") })).json();
      vues.push(...r.alertes.map((a: LigneAlerte) => a.id));
      curseur = r.curseur_suivant;
      if (!curseur) break;
    }
    expect(vues).toEqual([id(1), id(2), id(3)]);
    expect((await appli.inject({ method: "GET", url: "/api/console/v1/alertes?curseur=n-importe-quoi", headers: h("equipe") })).statusCode).toBe(400);
    expect((await appli.inject({ method: "GET", url: "/api/console/v1/alertes?limite=101", headers: h("equipe") })).statusCode).toBe(400);
  });

  it("[B-030] chaque ligne porte le compteur d'occurrences et rien d'autre que client, type, gravité, cause, responsable, état, dates", async () => {
    const r = (await appli.inject({ method: "GET", url: "/api/console/v1/alertes", headers: h("equipe") })).json();
    expect(Object.keys(r.alertes[0]).sort()).toEqual(["client", "cause", "cree_le", "etat", "gravite", "id", "occurrences", "responsable", "type"].sort());
    expect(r.alertes[0].occurrences).toBe(1);
  });

  it("[B-031] attribuer, commenter, clore ; clore sans motif → 422", async () => {
    const base = `/api/console/v1/alertes/${id(1)}`;
    expect((await appli.inject({ method: "POST", url: `${base}/attribuer`, headers: h("equipe"), payload: {} })).statusCode).toBe(200);
    expect((await appli.inject({ method: "POST", url: `${base}/commenter`, headers: h("equipe"), payload: { texte: "Je regarde." } })).statusCode).toBe(201);
    const sans = await appli.inject({ method: "POST", url: `${base}/clore`, headers: h("equipe"), payload: {} });
    expect(sans.statusCode).toBe(422);
    expect(sans.json().erreur.code).toBe("regle_metier");
    expect((await appli.inject({ method: "POST", url: `${base}/clore`, headers: h("equipe"), payload: { raison: "traitee" } })).statusCode).toBe(200);
    expect(appels).toEqual([`attribuer:${T1}:${id(1)}:membre-1`, `commenter:${T1}:${id(1)}:membre-1:11`, `clore:${T1}:${id(1)}:traitee:membre-1`]);
  });

  it("[B-031] s'attribuer pose assignee_a = l'acteur de la session (jamais une valeur du corps) et l'état acquittee", async () => {
    const r = await appli.inject({ method: "POST", url: `/api/console/v1/alertes/${id(1)}/attribuer`, headers: h("equipe"), payload: { acteur: "pirate" } });
    expect(r.statusCode).toBe(400); // aucun champ de corps accepté
    await appli.inject({ method: "POST", url: `/api/console/v1/alertes/${id(1)}/attribuer`, headers: h("equipe") });
    expect(appels).toEqual([`attribuer:${T1}:${id(1)}:membre-1`]);
    expect(r.body).not.toContain("pirate");
    expect((await appli.inject({ method: "GET", url: "/api/console/v1/alertes", headers: h("equipe") })).json().alertes).toHaveLength(3);
  });

  it("[B-031] un commentaire de plus de 500 caractères → 422, jamais tronqué", async () => {
    const url = `/api/console/v1/alertes/${id(1)}/commenter`;
    expect((await appli.inject({ method: "POST", url, headers: h("equipe"), payload: { texte: "x".repeat(501) } })).statusCode).toBe(422);
    expect((await appli.inject({ method: "POST", url, headers: h("equipe"), payload: { texte: "x".repeat(500) } })).statusCode).toBe(201);
    expect(appels).toEqual([`commenter:${T1}:${id(1)}:membre-1:500`]);
  });

  it("[B-031] clore avec une raison hors de la liste fermée → 422", async () => {
    const r = await appli.inject({ method: "POST", url: `/api/console/v1/alertes/${id(1)}/clore`, headers: h("equipe"), payload: { raison: "parce que" } });
    expect(r.statusCode).toBe(422);
    expect(appels).toEqual([]);
  });

  it("[B-031] une alerte déjà close → 422 ; une alerte inconnue → 404 ; un identifiant mal formé → 400", async () => {
    await monter(true, [ligne(1, { etat: "close" })]);
    const url = `/api/console/v1/alertes/${id(1)}`;
    // Le dépôt refuse de clore une alerte déjà close : la route rend 422 « regle_metier » avec le message dédié.
    const r = await appli.inject({ method: "POST", url: `${url}/clore`, headers: h("equipe"), payload: { raison: "traitee" } });
    expect(r.statusCode).toBe(422);
    expect(r.json().erreur.code).toBe("regle_metier");
    expect(r.json().erreur.message).toBe("Alerte déjà close.");
    expect((await appli.inject({ method: "POST", url: `/api/console/v1/alertes/${id(77)}/clore`, headers: h("equipe"), payload: { raison: "traitee" } })).statusCode).toBe(404);
    expect((await appli.inject({ method: "POST", url: "/api/console/v1/alertes/pas-un-uuid/clore", headers: h("equipe"), payload: { raison: "traitee" } })).statusCode).toBe(400);
  });

  it("[B-031] PUT regles-alertes/:id règle gravité, seuil, fenêtre ou activation, avec l'acteur ; un autre champ → 400 ; une valeur négative → 422", async () => {
    const url = `/api/console/v1/regles-alertes/${id(900)}`;
    const ok = await appli.inject({ method: "PUT", url, headers: h("equipe"), payload: { gravite: "critique", seuil: 5, fenetre_s: 300, active: false } });
    expect(ok.statusCode).toBe(200);
    expect(appels).toEqual([`regler:${id(900)}:${JSON.stringify({ gravite: "critique", seuil: 5, fenetre_s: 300, active: false })}:membre-1`]);
    expect((await appli.inject({ method: "PUT", url, headers: h("equipe"), payload: { code: "autre" } })).statusCode).toBe(400);
    expect((await appli.inject({ method: "PUT", url, headers: h("equipe"), payload: {} })).statusCode).toBe(400);
    expect((await appli.inject({ method: "PUT", url, headers: h("equipe"), payload: { seuil: -1 } })).statusCode).toBe(422);
    expect((await appli.inject({ method: "PUT", url, headers: h("equipe"), payload: { fenetre_s: 0 } })).statusCode).toBe(422);
    expect((await appli.inject({ method: "PUT", url: `/api/console/v1/regles-alertes/${id(901)}`, headers: h("equipe"), payload: { seuil: 1 } })).statusCode).toBe(404);
  });

  it("[B-031] un rôle absent de la matrice (« lecteur ») est refusé partout (403, refus tracé), lecture comprise", async () => {
    const b = `/api/console/v1/alertes/${id(1)}`;
    expect((await appli.inject({ method: "GET", url: "/api/console/v1/alertes", headers: h("inconnu") })).statusCode).toBe(403);
    for (const [m, u, p] of [["POST", `${b}/attribuer`, {}], ["POST", `${b}/commenter`, { texte: "a" }], ["POST", `${b}/clore`, { raison: "traitee" }], ["PUT", `/api/console/v1/regles-alertes/${id(900)}`, { seuil: 1 }]] as const) {
      expect((await appli.inject({ method: m, url: u, headers: h("inconnu"), payload: p })).statusCode).toBe(403);
    }
    expect(appels).toEqual([]);
    expect(refusTraces).toContain("lire:droit_refuse");
    expect(refusTraces).toContain("modifier_reglages:droit_refuse");
  });

  it("[B-031] @isolation un second administrateur limité au client A ne voit ni ne clôt les alertes du client B", async () => {
    const liste = (await appli.inject({ method: "GET", url: "/api/console/v1/alertes", headers: h("second_a") })).json();
    expect(liste.alertes.map((a: LigneAlerte) => a.id)).toEqual([id(1), id(2)]); // aucune alerte du client B (id 3)
    expect((await appli.inject({ method: "GET", url: `/api/console/v1/alertes?client=${T2}`, headers: h("second_a") })).statusCode).toBe(404);
    const b = `/api/console/v1/alertes/${id(3)}`; // alerte du client B
    for (const [u, p] of [[`${b}/attribuer`, {}], [`${b}/commenter`, { texte: "a" }], [`${b}/clore`, { raison: "traitee" }]] as const) {
      const r = await appli.inject({ method: "POST", url: u, headers: h("second_a"), payload: p });
      expect(r.statusCode).toBe(404); // même réponse qu'une alerte inconnue
    }
    expect(appels).toEqual([]);
    // témoin : sur une alerte du client A, il agit
    expect((await appli.inject({ method: "POST", url: `/api/console/v1/alertes/${id(1)}/clore`, headers: h("second_a"), payload: { raison: "traitee" } })).statusCode).toBe(200);
    // les règles sont globales : refusées au second administrateur dont la portée ne couvre pas tous les clients
    expect((await appli.inject({ method: "PUT", url: `/api/console/v1/regles-alertes/${id(900)}`, headers: h("second_a"), payload: { seuil: 1 } })).statusCode).toBe(404);
  });

  it("[B-031] @isolation une session client reçoit 403 sur toutes les routes d'alertes", async () => {
    const b = `/api/console/v1/alertes/${id(1)}`;
    for (const [m, u] of [["GET", "/api/console/v1/alertes"], ["POST", `${b}/attribuer`], ["POST", `${b}/commenter`], ["POST", `${b}/clore`], ["PUT", `/api/console/v1/regles-alertes/${id(900)}`]] as const) {
      const r = await appli.inject({ method: m, url: u, headers: h("client"), ...(m === "GET" ? {} : { payload: {} }) });
      expect(r.statusCode).toBe(403);
    }
    expect((await appli.inject({ method: "GET", url: "/api/console/v1/alertes" })).statusCode).toBe(403);
    expect(appels).toEqual([]);
  });

  it("[B-030] la route n'existe pas sans dépendances et répond 503 tant que l'interrupteur (SUPERVISION_ALERTES_OUVERTE) est fermé", async () => {
    const sans = Fastify();
    await sans.ready();
    expect((await sans.inject({ method: "GET", url: "/api/console/v1/alertes" })).statusCode).toBe(404);
    await monter(false);
    for (const [m, u] of [["GET", "/api/console/v1/alertes"], ["POST", `/api/console/v1/alertes/${id(1)}/clore`], ["PUT", `/api/console/v1/regles-alertes/${id(900)}`]] as const) {
      expect((await appli.inject({ method: m, url: u, headers: h("equipe"), ...(m === "GET" ? {} : { payload: { raison: "traitee" } }) })).statusCode).toBe(503);
    }
    expect(appels).toEqual([]);
  });
});
