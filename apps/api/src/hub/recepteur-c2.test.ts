import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { EN_TETES, signer } from "../../../../packages/contrats/src/commun/signature.js";
import type { CleEchange } from "../coffre/cles-echanges.js";
import { brancherErreurs } from "../plugins/erreurs.js";
import { brancherHub } from "../routes/hub.js";
import { DELAI_TROU_MS, FENETRE_RATTRAPAGE_MS, SEUIL_ALERTE_RATTRAPAGES, decider, intentionRattrapage, verifierTrous, type Depot, type FaitRange, type Rattrapage } from "./recepteur-c2.js";

// Clés de test générées au lancement : jamais écrites. Un secret par sens : le sens console → Hub ne doit jamais être accepté en réception.
const MAINTENANT = 1_800_000_000;
const HUB = { kid: "rec-hub-1", secret: randomBytes(32) } satisfies CleEchange;
const EMISSION = { kid: "emi-hub-1", secret: randomBytes(32) } satisfies CleEchange;
const CLIENT = "7a1c3e52-0b6d-4c8e-9f41-2d5b8a6c7e10";
const AUTRE_CLIENT = "9b2d4f63-1c7e-4d9f-8a52-3e6c9b7d8f21";
const SUJET = "AXI-CLI-000001";
const MARQUEUR_URL = "https://documents.exemple.fr/marqueur-secret-0001.pdf";

const facture = (sequence: number, extra: Record<string, unknown> = {}) => ({
  event_id: randomUUID(),
  schema_version: 1,
  occurred_at: "2026-10-24T10:00:00Z",
  emitted_at: "2026-10-24T10:00:01Z",
  producer: "axion-ia-hub",
  subject_ref: { axiCli: SUJET, consoleClientId: CLIENT },
  sequence,
  event_type: "facture.emise",
  payload: {
    numeroFacture: "AXI-FACT-000001",
    nature: "abonnement",
    debutPeriode: "2026-11-01",
    finPeriode: "2026-11-30",
    montantHtCentimes: 100,
    montantTvaCentimes: 20,
    montantTtcCentimes: 120,
    dateEmission: "2026-10-24",
    dateEcheance: "2026-11-23",
    pdf: { url: MARQUEUR_URL, expireAt: "2026-10-25T10:00:00Z", sha256: "a".repeat(64) },
  },
  ...extra,
});

type Ligne = Omit<FaitRange, "payload"> & { payload?: unknown; tenantId: string; recuLe: number; traite: boolean };
function depotEnMemoire(clientsConnus: string[] = [CLIENT]): Depot & { lignes: Ligne[]; verifies: string[] } {
  const lignes: Ligne[] = [];
  const verifies: string[] = [];
  return {
    lignes,
    verifies,
    async organisationExiste(tenantId) {
      verifies.push(tenantId);
      return clientsConnus.includes(tenantId);
    },
    async ranger(tenantId, fait, recuLe) {
      // Synchrone entre la recherche et l'ajout : même garantie qu'un INSERT … ON CONFLICT DO NOTHING.
      const dejaLa = lignes.find((l) => l.tenantId === tenantId && l.eventId === fait.eventId);
      if (dejaLa) return { neuf: false, traite: dejaLa.traite, payload: dejaLa.payload };
      lignes.push({ ...fait, tenantId, recuLe, traite: false });
      return { neuf: true, traite: false, payload: fait.payload };
    },
    async etatSujet(tenantId, sujet) {
      const duSujet = lignes.filter((l) => l.tenantId === tenantId && l.sujet === sujet);
      const traitees = duSujet.filter((l) => l.traite).map((l) => l.sequence);
      return {
        derniereTraitee: traitees.length ? Math.max(...traitees) : null,
        enAttente: duSujet.filter((l) => !l.traite).map((l) => ({ sequence: l.sequence, recuLe: l.recuLe })),
      };
    },
  };
}

function monter(options: { actif?: boolean; clients?: string[] } = {}) {
  const serveur = Fastify({ genReqId: () => randomUUID() });
  brancherErreurs(serveur);
  const depot = depotEnMemoire(options.clients);
  const taches: { nom: string; donnees: unknown; jobId?: string }[] = [];
  const rattrapages: Parameters<Rattrapage["demander"]>[0][] = [];
  const lignes: object[] = [];
  const vus = new Set<string>();
  brancherHub(serveur, {
    entrant: {
      cles: { async clesAcceptees(c, s) { return c === "c2" && s === "reception" ? [HUB] : []; } },
      memoire: { async set(k) { if (vus.has(k)) return null; vus.add(k); return "OK"; } },
      actif: () => options.actif ?? true,
      journal: { info: (o: object) => void lignes.push(o) },
      maintenant: () => MAINTENANT,
    },
    recepteur: {
      depot,
      file: { name: "faits-c2", async add(nom, donnees, opts) { taches.push({ nom, donnees, ...(opts?.jobId ? { jobId: opts.jobId } : {}) }); } },
      rattrapage: { async demander(d) { rattrapages.push(d); } },
      maintenant: () => MAINTENANT * 1000,
    },
  });
  return { serveur, depot, taches, rattrapages, lignes };
}

let compteur = 0;
function poster(corps: unknown, cle: CleEchange = HUB) {
  const texte = JSON.stringify(corps);
  const h = String(MAINTENANT);
  // Signature différente à chaque appel (anti-rejeu) : l'horodatage est fixe, donc le corps change par un espace final.
  const charge = texte + " ".repeat(++compteur);
  return {
    method: "POST" as const,
    url: "/api/hub/v1/faits",
    headers: {
      "content-type": "application/json",
      [EN_TETES.cle]: cle.kid,
      [EN_TETES.horodatage]: h,
      [EN_TETES.signature]: signer(cle.secret.toString("base64"), h, "POST", "/api/hub/v1/faits", charge),
    },
    payload: charge,
  };
}

describe("[C-338] réception des faits du Hub", () => {
  it("[A-133] @anti-doublon le même fait facture.emise reçu 3 fois, dont 2 en parallèle, est rangé une seule fois", async () => {
    const { serveur, depot, taches } = monter();
    const fait = facture(1);
    const [a, b] = await Promise.all([serveur.inject(poster(fait)), serveur.inject(poster(fait))]);
    const c = await serveur.inject(poster(fait));
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([200, 200, 200]);
    expect(depot.lignes).toHaveLength(1);
    // Une seule tâche : jobId dérivé de l'identifiant du fait, jamais du contenu.
    expect(new Set(taches.map((t) => t.jobId)).size).toBe(1);
  });

  it("[C-338] répond 200 pour un fait déjà traité, sans rien refaire", async () => {
    const { serveur, depot, taches } = monter();
    const fait = facture(1);
    await serveur.inject(poster(fait));
    for (const l of depot.lignes) l.traite = true;
    const avant = taches.length;
    const r = await serveur.inject(poster(fait));
    expect(r.statusCode).toBe(200);
    expect(depot.lignes).toHaveLength(1);
    expect(taches.length).toBe(avant);
  });

  it("[C-338] un fait signé avec la clé du sens console → Hub, ou non signé, n'est jamais rangé", async () => {
    const { serveur, depot } = monter();
    expect((await serveur.inject(poster(facture(1), EMISSION))).statusCode).toBe(401);
    const sansSignature = poster(facture(2));
    delete (sansSignature.headers as Record<string, string>)[EN_TETES.signature];
    expect((await serveur.inject(sansSignature)).statusCode).toBe(401);
    expect(depot.lignes).toHaveLength(0);
  });

  it("[C-338] porte fermée : 503 et rien de rangé", async () => {
    const { serveur, depot } = monter({ actif: false });
    expect((await serveur.inject(poster(facture(1)))).statusCode).toBe(503);
    expect(depot.lignes).toHaveLength(0);
  });

  it("[C-338] un fait d'un sujet inconnu, ou sans identifiant console, n'est pas rangé", async () => {
    const { serveur, depot } = monter();
    const inconnu = facture(1, { subject_ref: { axiCli: SUJET, consoleClientId: AUTRE_CLIENT } });
    expect((await serveur.inject(poster(inconnu))).statusCode).toBe(404);
    const sansId = facture(1, { subject_ref: { axiCli: SUJET } });
    expect((await serveur.inject(poster(sansId))).statusCode).toBe(400);
    expect(depot.lignes).toHaveLength(0);
  });

  it("[C-338] un payload qui ne respecte pas C2 est refusé (400) et rien n'est rangé", async () => {
    const { serveur, depot } = monter();
    const mauvais = facture(1);
    (mauvais.payload as Record<string, unknown>)["montantHtCentimes"] = 1.5;
    expect((await serveur.inject(poster(mauvais))).statusCode).toBe(400);
    expect(depot.lignes).toHaveLength(0);
  });

  it("[LOT2-c2] un event_type inconnu est rangé et mis en file, jamais perdu", async () => {
    const { serveur, depot, taches } = monter();
    const r = await serveur.inject(poster(facture(1, { event_type: "piece.signee", payload: { x: 1 } })));
    expect(r.statusCode).toBe(200);
    expect(depot.lignes.map((l) => l.type)).toEqual(["piece.signee"]);
    expect(taches).toHaveLength(1);
  });

  it("[LOT2-c2] l'URL signée du PDF n'est ni gardée ni journalisée", async () => {
    const { serveur, depot, taches, lignes } = monter();
    await serveur.inject(poster(facture(1)));
    const tout = JSON.stringify({ depot: depot.lignes, taches, lignes });
    expect(tout).not.toContain("marqueur-secret-0001");
    expect(JSON.stringify(taches)).toContain("a".repeat(64));
  });
});

describe("[C-338] fait perdu côté file : le payload vit en base", () => {
  it("[C-338] [T2-16] la file est perdue après le 200 : le Hub renvoie, le fait est retraité depuis la base", async () => {
    const { serveur, depot, taches } = monter();
    const fait = facture(1);
    expect((await serveur.inject(poster(fait))).statusCode).toBe(200);
    // Valkey redémarre sans persistance : la tâche n'existe plus.
    taches.length = 0;
    const tout = JSON.stringify(depot.lignes);
    expect(tout).toContain("AXI-FACT-000001");
    expect(tout).not.toContain("marqueur-secret-0001");
    expect((await serveur.inject(poster(fait))).statusCode).toBe(200);
    expect(taches).toHaveLength(1);
    expect(JSON.stringify(taches[0]?.donnees)).toContain("AXI-FACT-000001");
  });

  it("[C-338] [T2-16] tâche en échec (même jobId ignoré) : le renvoi du Hub remet une tâche portant le payload rangé", async () => {
    const { serveur, taches } = monter();
    const fait = facture(1);
    await serveur.inject(poster(fait));
    await serveur.inject(poster(fait));
    expect(taches).toHaveLength(2);
    expect(taches[1]?.donnees).toEqual(taches[0]?.donnees);
    expect(taches[1]?.jobId).toBe(taches[0]?.jobId);
  });

  it("[C-338] [T2-16] le payload est rangé avant la réponse 200 ; si le rangement échoue, 500 et rien en file", async () => {
    const { serveur, depot, taches } = monter();
    depot.ranger = async () => { throw new Error("base indisponible"); };
    expect((await serveur.inject(poster(facture(1)))).statusCode).toBe(500);
    expect(taches).toHaveLength(0);
  });

  it("[C-338] [T2-16] aucune PII ni lien dans ce qui est rangé : audit.cloture sans contact ni lien de compte rendu", async () => {
    const { serveur, depot, taches } = monter();
    const audit = facture(1, {
      event_type: "audit.cloture",
      payload: {
        siren: "123456782",
        contact: { nom: "Camille Test", email: "camille@exemple.fr" },
        typeAudit: "diagnostic_distance",
        dateAudit: "2026-10-20",
        outils: ["tableur"],
        besoins: [{ description: "Relances", priorite: 1, minutesPerduesParSemaineEstimees: 30 }],
        lienCompteRendu: "https://documents.exemple.fr/cr-secret-0002",
      },
    });
    expect((await serveur.inject(poster(audit))).statusCode).toBe(200);
    const tout = JSON.stringify({ lignes: depot.lignes, taches });
    expect(tout).not.toContain("camille@exemple.fr");
    expect(tout).not.toContain("Camille Test");
    expect(tout).not.toContain("cr-secret-0002");
    expect(tout).toContain("123456782");
  });
});

describe("[C-338] identifiant console du client", () => {
  it("[C-338] [T2-16] un consoleClientId qui n'est pas un UUID donne 400 sans appel au dépôt", async () => {
    const { serveur, depot, taches } = monter();
    for (const mauvais of ["abc", "7a1c3e52", "' OR 1=1 --", "7a1c3e52-0b6d-4c8e-9f41-2d5b8a6c7e1z"]) {
      const r = await serveur.inject(poster(facture(1, { subject_ref: { axiCli: SUJET, consoleClientId: mauvais } })));
      expect(r.statusCode).toBe(400);
    }
    expect(depot.verifies).toHaveLength(0);
    expect(depot.lignes).toHaveLength(0);
    expect(taches).toHaveLength(0);
  });
});

describe("[LOT2-c2] ordre des faits et rattrapage", () => {
  const il = (secondes: number) => MAINTENANT * 1000 - secondes * 1000;

  it("[LOT2-c2] un fait hors séquence attend ; le suivant du sujet est traitable", () => {
    expect(decider({ derniereTraitee: 1, enAttente: [{ sequence: 3, recuLe: il(5) }] }, MAINTENANT * 1000)).toEqual({ action: "attendre" });
    expect(decider({ derniereTraitee: 1, enAttente: [{ sequence: 3, recuLe: il(5) }, { sequence: 2, recuLe: il(4) }] }, MAINTENANT * 1000)).toEqual({ action: "traiter", sequence: 2 });
    expect(decider({ derniereTraitee: null, enAttente: [{ sequence: 0, recuLe: il(1) }] }, MAINTENANT * 1000)).toEqual({ action: "traiter", sequence: 0 });
    expect(decider({ derniereTraitee: 4, enAttente: [] }, MAINTENANT * 1000)).toEqual({ action: "rien" });
  });

  it("[LOT2-c2] un trou de plus de 10 minutes déclenche un seul rattrapage, avec une intention stable", async () => {
    const { depot, rattrapages } = monter();
    const rattrapage: Rattrapage = { async demander(d) { rattrapages.push(d); } };
    depot.lignes.push({ tenantId: CLIENT, eventId: randomUUID(), type: "facture.emise", sequence: 5, sujet: SUJET, recuLe: il(DELAI_TROU_MS / 1000 + 1), traite: false });
    depot.lignes.push({ tenantId: CLIENT, eventId: randomUUID(), type: "facture.emise", sequence: 3, sujet: SUJET, recuLe: il(1), traite: true });
    await verifierTrous({ depot, rattrapage }, CLIENT, SUJET, MAINTENANT * 1000);
    await verifierTrous({ depot, rattrapage }, CLIENT, SUJET, MAINTENANT * 1000 + 60_000);
    // Deux passes, une même intention : la boîte d'envoi (clé anti-doublon) n'en garde qu'une.
    expect(new Set(rattrapages.map((r) => r.intention))).toEqual(new Set([intentionRattrapage(CLIENT, SUJET, 4, MAINTENANT * 1000)]));
    expect(rattrapages.every((r) => r.tenantId === CLIENT && r.sujet === SUJET)).toBe(true);
  });

  it("[LOT2-c2] un trou de moins de 10 minutes, ou comblé, ne déclenche aucun rattrapage", async () => {
    const { depot, rattrapages } = monter();
    const rattrapage: Rattrapage = { async demander(d) { rattrapages.push(d); } };
    depot.lignes.push({ tenantId: CLIENT, eventId: randomUUID(), type: "facture.emise", sequence: 2, sujet: SUJET, recuLe: il(DELAI_TROU_MS / 1000 - 5), traite: false });
    await verifierTrous({ depot, rattrapage }, CLIENT, SUJET, MAINTENANT * 1000);
    // Le fait manquant (0 et 1) arrive : plus de trou, même si le fait 2 date de plus de 10 minutes.
    depot.lignes.push({ tenantId: CLIENT, eventId: randomUUID(), type: "facture.emise", sequence: 0, sujet: SUJET, recuLe: il(1), traite: true });
    depot.lignes.push({ tenantId: CLIENT, eventId: randomUUID(), type: "facture.emise", sequence: 1, sujet: SUJET, recuLe: il(1), traite: true });
    await verifierTrous({ depot, rattrapage }, CLIENT, SUJET, MAINTENANT * 1000 + 3_600_000);
    expect(rattrapages).toHaveLength(0);
  });
});

describe("[C-338] [T2-16] rattrapage renouvelé et alerte", () => {
  const il = (secondes: number) => MAINTENANT * 1000 - secondes * 1000;
  const trou = (depot: ReturnType<typeof depotEnMemoire>, tenantId = CLIENT) =>
    depot.lignes.push({ tenantId, eventId: randomUUID(), type: "facture.emise", sequence: 5, sujet: SUJET, recuLe: il(DELAI_TROU_MS / 1000 + 1), traite: false });

  it("[C-338] l'intention porte le client et une fenêtre de temps : deux clients, ou deux fenêtres, deux demandes", () => {
    const t = MAINTENANT * 1000;
    expect(intentionRattrapage(CLIENT, SUJET, 4, t)).toBe(intentionRattrapage(CLIENT, SUJET, 4, t + 1000));
    expect(intentionRattrapage(CLIENT, SUJET, 4, t)).not.toBe(intentionRattrapage(AUTRE_CLIENT, SUJET, 4, t));
    expect(intentionRattrapage(CLIENT, SUJET, 4, t)).not.toBe(intentionRattrapage(CLIENT, SUJET, 4, t + FENETRE_RATTRAPAGE_MS));
  });

  it("[C-338] le Hub ne comble pas le trou : une nouvelle demande part à la fenêtre suivante, et une alerte au-delà du seuil", async () => {
    const depot = depotEnMemoire();
    const rattrapages: Parameters<Rattrapage["demander"]>[0][] = [];
    const alertes: object[] = [];
    const deps = { depot, rattrapage: { async demander(d: Parameters<Rattrapage["demander"]>[0]) { rattrapages.push(d); } }, alerter: (a: object) => void alertes.push(a) };
    trou(depot);
    const t0 = MAINTENANT * 1000;
    for (let i = 0; i < SEUIL_ALERTE_RATTRAPAGES + 1; i++) await verifierTrous(deps, CLIENT, SUJET, t0 + i * FENETRE_RATTRAPAGE_MS);
    expect(new Set(rattrapages.map((r) => r.intention)).size).toBe(SEUIL_ALERTE_RATTRAPAGES + 1);
    expect(alertes.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(alertes)).not.toContain(CLIENT);
  });
});
