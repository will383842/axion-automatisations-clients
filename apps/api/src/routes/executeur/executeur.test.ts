import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { EN_TETES, signer } from "../../../../../packages/contrats/src/commun/signature.js";
import type { CleEchange } from "../../coffre/cles-echanges.js";
import { ErreurCoffre } from "../../coffre/coffre.js";
import { emettreJetonInstance } from "../../executeur/jeton-instance.js";
import type { InstanceResolue } from "../../executeur/portees.js";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { construireServeur } from "../../serveur.js";
import { executeurOuvert, routeExecuteur, type DepsExecuteur } from "./index.js";

// Clés générées au lancement : jamais écrites ni affichées.
const MAINTENANT = 1_800_000_000;
const PREFIXE = "/api/executeur/v1/instances";
const X = randomUUID();
const Y = randomUUID();
const TENANT = randomUUID();
const secret = () => randomBytes(32);
type Cle = CleEchange;

// Faux coffre espion : canal → clés ; `panne` simule un coffre indisponible, `appels` garde chaque lecture.
function monter(o: { actif?: boolean; instances?: Record<string, Partial<InstanceResolue>>; panneJi?: boolean; rejeuxPanne?: boolean } = {}) {
  const kv = new Map<string, Cle[]>([["c4-cellule-un", [{ kid: "k1", secret: secret() }]], ["c4-cellule-deux", [{ kid: "k1", secret: secret() }]], ["ji", [{ kid: "j1", secret: secret() }]]]);
  const appels: string[] = [];
  const vus = new Set<string>();
  const cles = {
    async cleActive(canal: string) { appels.push(`active:${canal}`); return kv.get(canal)![0]!; },
    async clesAcceptees(canal: string) {
      appels.push(`acceptees:${canal}`);
      if (canal === "ji" && o.panneJi) throw new ErreurCoffre("coffre_indisponible");
      const k = kv.get(canal);
      if (!k) throw new ErreurCoffre("introuvable");
      return k;
    },
  };
  const instances: Record<string, InstanceResolue> = {
    [X]: { tenantId: TENANT, celluleCode: "cellule-un", etat: "active", arretEnvois: false, version: 3 },
    [Y]: { tenantId: randomUUID(), celluleCode: "cellule-deux", etat: "active", arretEnvois: false, version: 1 },
  };
  for (const [id, v] of Object.entries(o.instances ?? {})) instances[id] = { ...instances[id]!, ...v };
  const deps: DepsExecuteur = {
    actif: () => o.actif ?? true,
    cles,
    memoire: { async set(k) { if (o.rejeuxPanne) throw new Error("panne"); if (vus.has(k)) return null; vus.add(k); return "OK"; } },
    depot: {
      async resoudre(id) { return instances[id] ?? null; },
      async configuration(tenantId, id) {
        return tenantId === instances[id]?.tenantId ? { instanceId: id, clientId: tenantId, automatisationId: randomUUID(), moduleCode: "relance-devis", moduleVersion: "1.2.0", reglages: { delai: 3 }, dureeCacheSecondes: 3600 } : null;
      },
    },
    maintenant: () => MAINTENANT,
  };
  const serveur = Fastify({ genReqId: () => randomUUID() });
  brancherErreurs(serveur);
  routeExecuteur(serveur, deps);
  const requete = async (o2: { cellule?: string; kid?: string; instance?: string; route?: "configuration" | "etat-voulu"; jeton?: string | null; horodatage?: number; cleSecret?: Buffer; signe?: boolean; suffixe?: string }) => {
    const cellule = o2.cellule ?? "cellule-un";
    const instance = o2.instance ?? X;
    const chemin = `${PREFIXE}/${instance}/${o2.route ?? "configuration"}${o2.suffixe ?? ""}`;
    const h = String(o2.horodatage ?? MAINTENANT);
    const headers: Record<string, string> = {};
    if (o2.signe !== false) {
      headers[EN_TETES.cle] = `c4:${cellule}:${o2.kid ?? "k1"}`;
      headers[EN_TETES.horodatage] = h;
      headers[EN_TETES.signature] = signer((o2.cleSecret ?? kv.get(`c4-${cellule}`)?.[0]?.secret ?? secret()).toString("base64"), h, "GET", chemin, "");
    }
    const jeton = o2.jeton === undefined ? await emettreJetonInstance(cles, { instanceId: instance, cellule }, () => MAINTENANT * 1000) : o2.jeton;
    if (jeton !== null) headers["authorization"] = `Instance ${jeton}`;
    return serveur.inject({ method: "GET", url: chemin, headers });
  };
  return { requete, kv, appels, cles, instances };
}

describe("API de l'exécuteur : signature de la cellule", () => {
  it("[A-339] une requête non signée ou hors fenêtre est refusée", async () => {
    const { requete } = monter();
    expect((await requete({ signe: false })).statusCode).toBe(401);
    const vieille = await requete({ horodatage: MAINTENANT - 301 });
    expect(vieille.statusCode).toBe(401);
    expect(vieille.json().erreur.code).toBe("signature_invalide");
    expect((await requete({ horodatage: MAINTENANT + 301 })).statusCode).toBe(401);
  });

  it("[A-339] interrupteur fermé : 503 porte_fermee, sans lire le coffre", async () => {
    const { requete, appels } = monter({ actif: false });
    const r = await requete({});
    expect(r.statusCode).toBe(503);
    expect(r.json().erreur.code).toBe("porte_fermee");
    expect(appels.filter((a) => a.startsWith("acceptees"))).toEqual([]);
  });

  it("[A-339] une requête signée déjà vue est refusée comme un rejeu, et une panne de la mémoire ferme la porte (503)", async () => {
    const { requete } = monter();
    expect((await requete({ route: "etat-voulu" })).statusCode).toBe(200);
    expect((await requete({ route: "etat-voulu" })).statusCode).toBe(401);
    expect((await monter({ rejeuxPanne: true }).requete({ route: "etat-voulu" })).statusCode).toBe(503);
  });

  it("[A-194] la clé de la cellule 2 ne signe pas pour la cellule 1", async () => {
    const m = monter();
    const r = await m.requete({ cellule: "cellule-un", cleSecret: m.kv.get("c4-cellule-deux")![0]!.secret });
    expect(r.statusCode).toBe(401);
  });

  it("[A-194] après rotation, l'ancienne clé marche (24 h) puis plus du tout", async () => {
    const m = monter();
    const ancienne = m.kv.get("c4-cellule-un")![0]!;
    m.kv.set("c4-cellule-un", [{ kid: "k2", secret: secret() }, ancienne]);
    expect((await m.requete({ kid: "k1", cleSecret: ancienne.secret, route: "etat-voulu" })).statusCode).toBe(200);
    m.kv.set("c4-cellule-un", [{ kid: "k2", secret: m.kv.get("c4-cellule-un")![0]!.secret }]);
    expect((await m.requete({ kid: "k1", cleSecret: ancienne.secret, route: "etat-voulu", suffixe: "?n=2" })).statusCode).toBe(401);
  });

  it("[C-016] un code de cellule inconnu donne exactement la même réponse qu'une signature fausse", async () => {
    const m = monter();
    const inconnue = await m.requete({ cellule: "cellule-fantome", cleSecret: secret() });
    const fausse = await m.requete({ cleSecret: secret(), suffixe: "?n=3" });
    const norme = (r: { statusCode: number; json(): { erreur: { code: string; message: string } } }) => [r.statusCode, r.json().erreur.code, r.json().erreur.message];
    expect(norme(inconnue)).toEqual(norme(fausse));
    expect(inconnue.statusCode).toBe(401);
  });
});

describe("API de l'exécuteur : jeton d'instance et isolation", () => {
  it("[C-017] @isolation la cellule 1 avec un jeton valide de l'instance X ne lit pas l'instance Y : 404", async () => {
    const m = monter();
    const jetonX = await emettreJetonInstance(m.cles, { instanceId: X, cellule: "cellule-un" }, () => MAINTENANT * 1000);
    const r = await m.requete({ instance: Y, jeton: jetonX });
    expect(r.statusCode).toBe(404);
    expect(r.json().erreur.code).toBe("introuvable");
    const inexistante = await m.requete({ instance: randomUUID(), jeton: jetonX, suffixe: "?n=4" });
    expect([inexistante.statusCode, inexistante.json().erreur.message]).toEqual([r.statusCode, r.json().erreur.message]);
  });

  it("[C-017] @isolation un jeton d'instance rejoué par une autre cellule est refusé", async () => {
    const m = monter();
    const jetonX = await emettreJetonInstance(m.cles, { instanceId: X, cellule: "cellule-un" }, () => MAINTENANT * 1000);
    expect((await m.requete({ cellule: "cellule-deux", instance: X, jeton: jetonX })).statusCode).toBe(404);
  });

  it("[C-017] un jeton signé pour la cellule X dont la charge nomme la cellule Y est refusé : la cellule attendue vient de la signature et de la base", async () => {
    const m = monter({ instances: { [X]: { celluleCode: "cellule-deux" } } });
    const jetonY = await emettreJetonInstance(m.cles, { instanceId: X, cellule: "cellule-un" }, () => MAINTENANT * 1000);
    expect((await m.requete({ cellule: "cellule-deux", instance: X, jeton: jetonY })).statusCode).toBe(404);
    const bon = await emettreJetonInstance(m.cles, { instanceId: X, cellule: "cellule-deux" }, () => MAINTENANT * 1000);
    expect((await m.requete({ cellule: "cellule-deux", instance: X, jeton: bon, suffixe: "?n=5" })).statusCode).toBe(200);
  });

  it("[C-017] la route relit la base à chaque requête : arrêt des envois ou changement de cellule après l'émission, le jeton est refusé", async () => {
    const m = monter();
    const jeton = await emettreJetonInstance(m.cles, { instanceId: X, cellule: "cellule-un" }, () => MAINTENANT * 1000);
    expect((await m.requete({ jeton })).statusCode).toBe(200);
    m.instances[X]!.arretEnvois = true;
    expect((await m.requete({ jeton, suffixe: "?n=2" })).statusCode).toBe(404);
    m.instances[X]!.arretEnvois = false;
    m.instances[X]!.celluleCode = "cellule-deux";
    expect((await m.requete({ jeton, suffixe: "?n=3" })).statusCode).toBe(404);
  });

  it("[C-017] un jeton mal formé est refusé sans aucun appel au coffre des jetons, et une panne du coffre répond proprement (404, jamais 500)", async () => {
    const m = monter();
    for (const [i, jeton] of ["", "x", "ji1.a.b", "ji1.!!.!!", "Bearer", null].entries()) {
      const r = await m.requete({ jeton, suffixe: `?n=${i}` });
      expect(r.statusCode, String(jeton)).toBe(404);
    }
    expect(m.appels.filter((a) => a.endsWith(":ji"))).toEqual([]);
    const panne = monter({ panneJi: true });
    const r = await panne.requete({});
    expect(r.statusCode).toBe(404);
    expect(r.json().erreur.code).toBe("introuvable");
  });

  it("[C-017] une instance dont l'état est livree n'est plus servie en configuration ; l'état voulu dit arrete", async () => {
    const m = monter({ instances: { [X]: { etat: "livree" } } });
    expect((await m.requete({})).statusCode).toBe(404);
    expect((await m.requete({ route: "etat-voulu", suffixe: "?n=2" })).json().etat).toBe("arrete");
  });
});

describe("API de l'exécuteur : réponses", () => {
  it("[A-168] la réponse de configuration ne contient que la liste fermée de clés de la configuration de l'instance", async () => {
    const r = await monter().requete({});
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(["automatisationId", "clientId", "dureeCacheSecondes", "instanceId", "moduleCode", "moduleVersion", "reglages"]);
  });

  it("[A-168] un tenant_id fourni par la requête (en-tête ou paramètre) est ignoré : la base décide", async () => {
    const r = await monter().requete({ suffixe: `?tenant_id=${randomUUID()}` });
    expect(r.statusCode).toBe(200);
    expect(r.json().clientId).toBe(TENANT);
  });

  it("[C-017] l'état voulu est servi sans jeton d'instance mais avec la signature, cache 3600 s, version de la base", async () => {
    const m = monter({ instances: { [X]: { etat: "erreur", arretEnvois: true } } });
    const r = await m.requete({ route: "etat-voulu", jeton: null });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ instanceId: X, etat: "pause", arretEnvois: true, version: 3 });
    expect(r.headers["cache-control"]).toBe("private, max-age=3600");
    expect((await m.requete({ route: "etat-voulu", signe: false })).statusCode).toBe(401);
    expect((await m.requete({ route: "etat-voulu", instance: Y, suffixe: "?n=2" })).statusCode).toBe(404);
  });

  it("[C-017] la correspondance des états : active→actif, pause→pause, erreur→pause, livree→arrete", async () => {
    const m = monter();
    const lire = async (etat: string, n: number) => { m.instances[X]!.etat = etat as InstanceResolue["etat"]; return (await m.requete({ route: "etat-voulu", jeton: null, suffixe: `?n=${n}` })).json().etat; };
    expect([await lire("active", 1), await lire("pause", 2), await lire("erreur", 3), await lire("livree", 4)]).toEqual(["actif", "pause", "pause", "arrete"]);
  });
});

describe("API de l'exécuteur : interrupteur", () => {
  it("[A-339] EXECUTEUR_API_OUVERTE est fermé par défaut et la route n'existe pas sans dépendances", async () => {
    expect([{}, { EXECUTEUR_API_OUVERTE: "" }, { EXECUTEUR_API_OUVERTE: "0" }, { EXECUTEUR_API_OUVERTE: "oui" }].map(executeurOuvert)).toEqual([false, false, false, false]);
    expect([{ EXECUTEUR_API_OUVERTE: "1" }, { EXECUTEUR_API_OUVERTE: "true" }].map(executeurOuvert)).toEqual([true, true]);
    const r = await construireServeur().inject({ method: "GET", url: `${PREFIXE}/${X}/etat-voulu` });
    expect(r.statusCode).toBe(404);
  });
});
