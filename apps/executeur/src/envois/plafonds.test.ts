import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnecteurFactice } from "../noyau/memoire/connecteur-factice.ts";
import { ErreurConnecteur } from "../noyau/politique-erreurs.ts";
import { garderConnecteurs } from "./garde-envoi.ts";
import { jourParis, plafondDeMontee } from "./montee.ts";
import { noterLimiteAtteinte, reserverEnvoi, type ContextePlafonds } from "./plafonds.ts";

// Plafonds d'envoi par boîte (T4-45) : Valkey simulé (INCR, DECR, EXPIRE, GET, SET NX), horloge injectée, aucune donnée réelle.
const A = randomUUID();
const B = randomUUID();
class FauxValkey {
  cles = new Map<string, string>();
  // Durée de vie restante (secondes) des clés qui en ont une ; `vieillir` fait passer le temps et expire les clés échues.
  ttl = new Map<string, number>();
  vieillir(secondes: number) {
    for (const [cle, reste] of [...this.ttl]) {
      if (reste <= secondes) { this.cles.delete(cle); this.ttl.delete(cle); } else this.ttl.set(cle, reste - secondes);
    }
  }
  async mget(...cles: string[]) { return cles.map((c) => this.cles.get(c) ?? null); }
  async call(commande: string, ...args: string[]): Promise<unknown> {
    const [cle = "", valeur = "", ...options] = args;
    if (commande === "GET") return this.cles.get(cle) ?? null;
    if (commande === "INCR" || commande === "DECR") {
      const n = Number(this.cles.get(cle) ?? 0) + (commande === "INCR" ? 1 : -1);
      this.cles.set(cle, String(n));
      return n;
    }
    if (commande === "EXPIRE") { this.ttl.set(cle, Number(valeur)); return 1; }
    if (commande === "SET") {
      const ancien = this.cles.get(cle) ?? null;
      if (options.includes("NX") && ancien !== null) return null;
      this.cles.set(cle, valeur);
      const i = options.indexOf("EX");
      if (i >= 0) this.ttl.set(cle, Number(options[i + 1])); else this.ttl.delete(cle);
      return "OK";
    }
    throw new Error(`commande ${commande}`);
  }
}
const JOUR1 = new Date("2026-03-10T09:00:00+01:00");
const plus = (d: Date, jours: number, minutes = 0) => new Date(d.getTime() + jours * 86_400_000 + minutes * 60_000);

function banc(o: { limites?: ContextePlafonds["config"]["limites"]; plafondClient?: number; fournisseur?: "microsoft365" | "gmail" | "imap"; valkey?: FauxValkey } = {}) {
  const valkey = o.valkey ?? new FauxValkey();
  const horloge = { t: JOUR1 };
  const tracees: string[] = [];
  const ctx = (tenantId = A, boite = "boite-1"): ContextePlafonds => ({
    valkey, config: { limites: o.limites ?? {} }, tenantId, boite, fournisseur: o.fournisseur ?? "microsoft365", ...(o.plafondClient === undefined ? {} : { plafondClient: o.plafondClient }),
    maintenant: () => horloge.t, tracer: (c) => tracees.push(c),
  });
  // Envoie n messages ; rend le nombre partis et le nombre reportés (chaque report porte une date d'attente au jour suivant).
  const envoyer = async (n: number, c = ctx()) => {
    let partis = 0, reportes = 0, attente = 0;
    for (let i = 0; i < n; i++) {
      try { await reserverEnvoi(c); partis++; } catch (e) {
        if (!(e instanceof ErreurConnecteur) || e.code !== "plafond_atteint") throw e;
        reportes++; attente = e.attenteJusqua ?? 0;
      }
    }
    return { partis, reportes, attente };
  };
  return { valkey, horloge, ctx, envoyer, tracees };
}

describe("montée des plafonds", () => {
  it("[A-274] la montée est linéaire de 50 (jour 1) à 300 (jour 28 et suivants)", () => {
    expect(plafondDeMontee(1)).toBe(50);
    expect(plafondDeMontee(28)).toBe(300);
    expect(plafondDeMontee(90)).toBe(300);
    for (let j = 2; j <= 28; j++) expect(plafondDeMontee(j)).toBeGreaterThanOrEqual(plafondDeMontee(j - 1));
    expect(jourParis(new Date("2026-03-10T23:30:00Z"))).toBe("2026-03-11");
  });

  it("[A-274] @envoi jour 1 : le 51e envoi est reporté au lendemain", async () => {
    const b = banc();
    const r = await b.envoyer(51);
    expect(r).toMatchObject({ partis: 50, reportes: 1 });
    expect(jourParis(new Date(r.attente))).toBe("2026-03-11");
    expect(new Date(r.attente).getTime()).toBeGreaterThan(b.horloge.t.getTime());
  });

  it("[A-274] jour 28 : plafond 300", async () => {
    const b = banc();
    await b.envoyer(1);
    b.horloge.t = plus(JOUR1, 27);
    expect(await b.envoyer(301)).toMatchObject({ partis: 300, reportes: 1 });
  });

  it("[A-274] une boîte silencieuse plus de 30 jours redescend d'un cran (7 jours de montée)", async () => {
    const b = banc();
    await b.envoyer(1);
    b.horloge.t = plus(JOUR1, 27);
    await b.envoyer(1); // jour 28 : 300, dernier envoi ce jour-là
    b.horloge.t = plus(JOUR1, 27 + 31); // 31 jours de silence
    const r = await b.envoyer(400);
    expect(r.partis).toBe(plafondDeMontee(28 - 7));
    expect(r.partis).toBeLessThan(300);
  });
});

describe("limites et plafond du client", () => {
  it("[A-275] @envoi limite du fournisseur plus basse que la montée : la limite du fournisseur gagne (marge de 20 %)", async () => {
    const b = banc({ limites: { microsoft365: { parJour: 40 } } });
    expect(await b.envoyer(60)).toMatchObject({ partis: 32, reportes: 28 });
  });

  it("[A-275] une limite par minute du fournisseur est tenue, puis la minute suivante repart", async () => {
    const b = banc({ limites: { microsoft365: { parMinute: 10 } } });
    expect(await b.envoyer(15)).toMatchObject({ partis: 8, reportes: 7 });
    b.horloge.t = plus(JOUR1, 0, 1);
    expect(await b.envoyer(5)).toMatchObject({ partis: 5, reportes: 0 });
  });

  it("[A-275] aucune limite relevée pour le fournisseur : seule la montée s'applique, aucune valeur inventée", async () => {
    const b = banc({ limites: { gmail: { parJour: 5 } } });
    expect((await b.envoyer(60)).partis).toBe(50);
  });

  it("[A-275] un 429 abaisse le plafond du jour à ce qui est déjà parti", async () => {
    const b = banc();
    expect((await b.envoyer(20)).partis).toBe(20);
    await noterLimiteAtteinte(b.ctx());
    expect(await b.envoyer(5)).toMatchObject({ partis: 0, reportes: 5 });
    b.horloge.t = plus(JOUR1, 1);
    expect((await b.envoyer(5)).partis).toBe(5);
  });

  it("[B-193] un réglage du client qui demande 1 000 envois par jour est ignoré et tracé", async () => {
    const b = banc({ plafondClient: 30 });
    const c = { ...b.ctx(), reglagesClient: { plafondEnvoisParJour: 1000 } };
    expect(await b.envoyer(60, c)).toMatchObject({ partis: 30, reportes: 30 });
    expect(b.tracees).toContain("reglage_client_ignore");
  });

  it("[C-085] @envoi 400 envois demandés un jour à 300 : 300 partent, 100 reportés, aucun doublon le lendemain", async () => {
    const b = banc();
    await b.envoyer(1);
    b.horloge.t = plus(JOUR1, 27);
    const jour28 = await b.envoyer(400);
    expect(jour28).toMatchObject({ partis: 300, reportes: 100 });
    // Le lendemain, seuls les 100 reportés repartent ; les 300 déjà partis ne repartent pas.
    b.horloge.t = plus(JOUR1, 28);
    expect(await b.envoyer(100)).toMatchObject({ partis: 100, reportes: 0 });
  });

  it("[A-206] les plafonds s'appliquent à toutes les instances de la cellule mutualisée : une boîte, un compteur ; un autre client a le sien", async () => {
    const b = banc();
    const connecteur = new ConnecteurFactice();
    const garde = (instanceId: string, tenantId = A) => garderConnecteurs(connecteur, {
      valkey: b.valkey, tenantId, instanceId, executionId: `e-${instanceId}`, annulable: false,
      proprietaireJeton: { clientDuJeton: async () => tenantId }, carnet: { connait: async () => true }, plafonds: b.ctx(tenantId),
    });
    let n = 0;
    const envoyer = (g: ReturnType<typeof garde>) => g.appeler("envoyer", { cle: `c-${++n}`, element: "m", entree: { destinataire: "client@exemple.fr" }, signal: new AbortController().signal });
    const i1 = garde("inst-1"), i2 = garde("inst-2");
    let partis = 0, reportes = 0;
    for (let i = 0; i < 60; i++) await (i % 2 ? envoyer(i1) : envoyer(i2)).then(() => partis++, (e: ErreurConnecteur) => { expect(e.code).toBe("plafond_atteint"); reportes++; });
    expect(partis).toBe(50);
    expect(reportes).toBe(10);
    expect(connecteur.appels).toHaveLength(50);
    await expect(envoyer(garde("inst-9", B))).resolves.toBeDefined();
  });

  it("[B-193] un plafond du client à 0 bloque tous les envois (0 n'est pas « pas de plafond »)", async () => {
    const b = banc({ plafondClient: 0 });
    expect(await b.envoyer(5)).toMatchObject({ partis: 0, reportes: 5 });
  });

  it("[A-274] après plus de 90 jours d'envois continus, la boîte garde son rang dans la montée (la date du premier envoi n'expire pas)", async () => {
    const b = banc();
    // Un envoi par jour pendant 95 jours : la clé du premier envoi a dépassé ses 90 jours de vie si elle n'est jamais rafraîchie.
    for (let j = 0; j < 95; j++) {
      b.horloge.t = plus(JOUR1, j);
      expect((await b.envoyer(1)).partis).toBe(1);
      b.valkey.vieillir(86_400);
    }
    b.horloge.t = plus(JOUR1, 95);
    expect((await b.envoyer(120)).partis).toBe(120);
  });

  it("[A-206] un identifiant de boîte contenant « : » est refusé (aucune clé forgée vers la boîte d'un autre)", async () => {
    const b = banc();
    await expect(b.envoyer(1, b.ctx(A, "boite-1:j:2026-03-10"))).rejects.toBeDefined();
    expect(b.valkey.cles.size).toBe(0);
  });

  it("[C-085] un envoi refusé par le connecteur rend sa place ; une limite atteinte (quota) n'en rend aucune", async () => {
    const b = banc();
    const connecteur = new ConnecteurFactice();
    const g = garderConnecteurs({ verifier: connecteur.verifier.bind(connecteur), appeler: async () => { throw new ErreurConnecteur("definitive", "refuse"); } }, {
      valkey: b.valkey, tenantId: A, instanceId: "i", executionId: "e", annulable: false,
      proprietaireJeton: { clientDuJeton: async () => A }, carnet: { connait: async () => true }, plafonds: b.ctx(),
    });
    for (let i = 0; i < 3; i++) await expect(g.appeler("envoyer", { cle: `c${i}`, element: "m", entree: { destinataire: "client@exemple.fr" }, signal: new AbortController().signal })).rejects.toMatchObject({ code: "refuse" });
    expect((await b.envoyer(60)).partis).toBe(50);
  });
});
