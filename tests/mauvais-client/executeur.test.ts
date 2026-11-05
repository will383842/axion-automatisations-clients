import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EN_TETES, signer } from "../../packages/contrats/src/commun/signature.js";
import { emettreJetonInstance } from "../../apps/api/src/executeur/jeton-instance.js";
import type { InstanceResolue } from "../../apps/api/src/executeur/portees.js";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeExecuteur } from "../../apps/api/src/routes/executeur/index.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Routes de l'exécuteur (T4-21). Le « client » qui appelle est la cellule signée : l'instance d'un autre client, portée par une autre cellule,
// donne la réponse d'une instance absente (404 identique) et la base de configuration n'est jamais lue (C-536).
const MAINTENANT = 1_800_000_000;
const PREFIXE = "/api/executeur/v1/instances";
const A = randomUUID();
const B = randomUUID();
const ABSENTE = randomUUID();
const secret = () => randomBytes(32);

function monter() {
  const kv = new Map([["c4-cellule-un", { kid: "k1", secret: secret() }], ["c4-cellule-deux", { kid: "k1", secret: secret() }], ["ji", { kid: "j1", secret: secret() }]]);
  const cles = {
    async cleActive(canal: string) { return kv.get(canal)!; },
    async clesAcceptees(canal: string) { return [kv.get(canal)!]; },
  };
  const instances: Record<string, InstanceResolue> = {
    [A]: { tenantId: randomUUID(), celluleCode: "cellule-un", etat: "active", arretEnvois: false, version: 1 },
    [B]: { tenantId: randomUUID(), celluleCode: "cellule-deux", etat: "active", arretEnvois: false, version: 1 },
  };
  let lectures = 0;
  const vus = new Set<string>();
  const serveur = fastifyVide();
  brancherErreurs(serveur);
  routeExecuteur(serveur, {
    actif: () => true,
    cles: cles as never,
    memoire: { async set(k: string) { if (vus.has(k)) return null; vus.add(k); return "OK"; } } as never,
    depot: {
      async resoudre(id) { return instances[id] ?? null; },
      async configuration() { lectures++; return null; },
    },
    maintenant: () => MAINTENANT,
  });
  const appeler = async (route: "configuration" | "etat-voulu", instance: string) => {
    const chemin = `${PREFIXE}/${instance}/${route}`;
    const h = String(MAINTENANT);
    const jeton = await emettreJetonInstance(cles as never, { instanceId: instance, cellule: "cellule-un" }, () => MAINTENANT * 1000);
    const r = await serveur.inject({
      method: "GET",
      url: chemin,
      headers: {
        [EN_TETES.cle]: "c4:cellule-un:k1",
        [EN_TETES.horodatage]: h,
        [EN_TETES.signature]: signer(kv.get("c4-cellule-un")!.secret.toString("base64"), h, "GET", chemin, ""),
        authorization: `Instance ${jeton}`,
      },
    });
    const corps = r.json() as { erreur?: { id_trace?: string } };
    if (corps.erreur) delete corps.erreur.id_trace;
    return { statut: r.statusCode, corps };
  };
  return { appeler, lectures: () => lectures };
}

async function verifier(route: "configuration" | "etat-voulu") {
  const m = monter();
  const autreClient = await m.appeler(route, B);
  const absente = await m.appeler(route, ABSENTE);
  expect(autreClient).toEqual(absente);
  expect(autreClient.statut).toBe(404);
  expect(m.lectures()).toBe(0);
  // Témoin : sa propre instance passe le contrôle d'appartenance (le refus vient bien de la cellule).
  expect((await m.appeler(route, A)).statut).not.toBe(404);
  return autreClient.statut;
}

describe("mauvais client : routes de l'exécuteur", () => {
  it("[C-536] @isolation GET /api/executeur/v1/instances/:instanceId/configuration", async () => expect(await verifier("configuration")).toBe(404));
  it("[C-536] @isolation GET /api/executeur/v1/instances/:instanceId/etat-voulu", async () => expect(await verifier("etat-voulu")).toBe(404));
});
