import { describe, expect, it } from "vitest";
import { construireServeur } from "../serveur.ts";
import { ErreurApi } from "../plugins/erreurs.ts";
import { ErreurRegleMetier } from "./activer.ts";
import type { DepsDeploiementInstances } from "../routes/instances/deploiement.ts";

// Route de déploiement (T4-28b1) : absente par défaut, fermée (503) tant que l'interrupteur est fermé, réservée à l'équipe. Les services sont des faux : aucune base.
const A = "11111111-1111-4111-8111-111111111111";
const INSTANCE = "66666666-6666-4666-8666-666666666666";
const CREATION = `/api/console/v1/clients/${A}/instances`;
const CORPS = { organisation_id: "33333333-3333-4333-8333-333333333333", version_id: "44444444-4444-4444-8444-444444444444", formule: "abonnement", reglages: {} };

function deps(o: { ouvert?: boolean; equipe?: boolean; activation?: Error } = {}) {
  const appels: string[] = [];
  const d: DepsDeploiementInstances = {
    ouvert: o.ouvert ?? true,
    async authentifier(requete) {
      appels.push("authentifier");
      if (!o.equipe && requete.headers["x-equipe"] !== "oui") throw new ErreurApi("action_interdite", "Action interdite.");
      return { acteur: "equipe-essai" };
    },
    async creer(tenantId, acteur, demande) {
      appels.push(`creer:${tenantId}:${acteur}:${demande.version_id}`);
      return { instanceId: INSTANCE, configurationId: "77777777-7777-4777-8777-777777777777", etat: "pause" };
    },
    async tester(tenantId, acteur, instanceId) {
      appels.push(`tester:${tenantId}:${acteur}:${instanceId}`);
      return { id: "99999999-9999-4999-8999-999999999999", resultat: "reussi", lectures: 5, brouillons: 2, envois: 0, dureeMs: 120, codeErreur: null };
    },
    async activer(tenantId, acteur, instanceId) {
      appels.push(`activer:${tenantId}:${acteur}:${instanceId}`);
      if (o.activation) throw o.activation;
    },
  };
  return { d, appels };
}
const poster = (s: ReturnType<typeof construireServeur>, url: string, corps: unknown = CORPS, equipe = true) =>
  s.inject({ method: "POST", url, headers: equipe ? { "x-equipe": "oui" } : {}, payload: corps as never });

describe("route de déploiement d'une instance", () => {
  it("[B-312] la route de déploiement n'existe pas sans dépendances, répond 503 interrupteur fermé et refuse une session client (403)", async () => {
    expect((await poster(construireServeur(), CREATION)).statusCode).toBe(404);
    const fermee = deps({ ouvert: false });
    const s = construireServeur({ deploiementInstances: fermee.d });
    for (const url of [CREATION, `${CREATION}/${INSTANCE}/tests-a-blanc`, `${CREATION}/${INSTANCE}/activation`]) {
      const r = await poster(s, url, { corps: "n'importe quoi" });
      expect(r.statusCode, url).toBe(503);
      expect(r.json().erreur.code, url).toBe("porte_fermee");
    }
    expect(fermee.appels).toEqual([]);
    const ouverte = deps();
    const client = await poster(construireServeur({ deploiementInstances: ouverte.d }), CREATION, CORPS, false);
    expect(client.statusCode).toBe(403);
    expect(ouverte.appels).toEqual(["authentifier"]);
  });

  it("[B-312] la création prend le client du chemin et l'acteur de la session, refuse une clé inconnue ou un identifiant invalide, et rend 201", async () => {
    const { d, appels } = deps();
    const s = construireServeur({ deploiementInstances: d });
    const r = await poster(s, CREATION);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ instance_id: INSTANCE, configuration_id: "77777777-7777-4777-8777-777777777777", etat: "pause" });
    expect(appels).toEqual(["authentifier", `creer:${A}:equipe-essai:${CORPS.version_id}`]);
    expect((await poster(s, CREATION, { ...CORPS, tenant_id: A })).statusCode).toBe(400);
    expect((await poster(s, "/api/console/v1/clients/pas-un-uuid/instances")).statusCode).toBe(400);
    expect(appels.filter((a) => a.startsWith("creer:")).length).toBe(1);
  });

  it("[B-093] la route du test à blanc rend un rapport fermé (compteurs et code) pour l'instance du client du chemin", async () => {
    const { d, appels } = deps();
    const r = await poster(construireServeur({ deploiementInstances: d }), `${CREATION}/${INSTANCE}/tests-a-blanc`, {});
    expect(r.statusCode).toBe(201);
    expect(Object.keys(r.json()).sort()).toEqual(["brouillons", "code_erreur", "duree_ms", "envois", "id", "lectures", "resultat"]);
    expect(appels[1]).toBe(`tester:${A}:equipe-essai:${INSTANCE}`);
  });

  it("[C-628] la route d'activation rend le motif de la garde qui dit non (422) et 404 pour une instance d'un autre client", async () => {
    const refus = deps({ activation: new ErreurRegleMetier("test_a_blanc_absent") });
    const r = await poster(construireServeur({ deploiementInstances: refus.d }), `${CREATION}/${INSTANCE}/activation`, {});
    expect(r.statusCode).toBe(422);
    expect(r.json().erreur.code).toBe("regle_metier");
    expect(r.json().erreur.message).toMatch(/test à blanc/);
    const absente = deps({ activation: new ErreurRegleMetier("instance_introuvable") });
    const autre = await poster(construireServeur({ deploiementInstances: absente.d }), `${CREATION}/${INSTANCE}/activation`, {});
    expect(autre.statusCode).toBe(404);
    expect(autre.json().erreur.code).toBe("introuvable");
    const bon = deps();
    const ok = await poster(construireServeur({ deploiementInstances: bon.d }), `${CREATION}/${INSTANCE}/activation`, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ instance_id: INSTANCE, etat: "active" });
  });
});
