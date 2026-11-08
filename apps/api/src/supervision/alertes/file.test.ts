import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { DELAI_RELANCE_MS, TYPES_SERVICE, depotSqlFile, ouvrirAlerte, relanceDue, surChangementSante, type DepotFile, type Notifications } from "./ouvrir.js";
import { RAISONS_CLOTURE, ErreurCycle, clore, commenter, retablirAlerte, type DepotCycle } from "./cycle.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const H = 3_600_000;

// Dépôt en mémoire qui imite les règles de la base : une alerte en cours par (client, clé), compteur = occurrences, relance sous 2 h, clôture unique.
function memoire(horloge: { t: number }) {
  type A = { id: string; tenant: string; cle: string; cree: number; etat: "ouverte" | "acquittee" | "close"; occ: { instance: string | null; relance: boolean; t: number }[]; cloture?: { raison: string; auteur: string } };
  const alertes: A[] = [];
  const echoue = { valeur: false };
  const depot: DepotFile & DepotCycle = {
    async ouvrirOuCompter(tenant, e) {
      if (echoue.valeur) throw new Error("transaction annulée");
      let a = alertes.find((x) => x.tenant === tenant && x.cle === e.cle && x.etat !== "close");
      const nouvelle = !a;
      if (!a) alertes.push((a = { id: `a${alertes.length + 1}`, tenant, cle: e.cle, cree: horloge.t, etat: "ouverte", occ: [] }));
      const repere = Math.max(a.cree, ...a.occ.filter((o) => o.relance).map((o) => o.t));
      const relance = !nouvelle && relanceDue(repere, horloge.t);
      a.occ.push({ instance: e.instanceId, relance, t: horloge.t });
      return { alerteId: a.id, nouvelle, relance };
    },
    async retablir(tenant, cle) {
      if (echoue.valeur) throw new Error("transaction annulée");
      const a = alertes.find((x) => x.tenant === tenant && x.cle === cle && x.etat !== "close");
      if (!a) return null;
      a.etat = "close";
      a.cloture = { raison: "retabli", auteur: "supervision" };
      return { alerteId: a.id };
    },
    async attribuer() {
      return true;
    },
    async commenter() {},
    async clore(tenant, id, raison, acteur) {
      const a = alertes.find((x) => x.tenant === tenant && x.id === id && x.etat !== "close");
      if (!a) return false;
      a.etat = "close";
      a.cloture = { raison, auteur: acteur };
      return true;
    },
  };
  return { alertes, depot, echoue };
}
function notifs() {
  const envoyees: string[] = [];
  const n: Notifications = { async relance(_t, id) { envoyees.push(`relance:${id}`); }, async retabli(_t, id) { envoyees.push(`retabli:${id}`); } };
  return { envoyees, n };
}
const entree = { type: "connexion_expiree", gravite: "avertissement" as const, regle: "sante_orange", cause: { cause: "timeout", connecteur: "mail" }, instanceId: null };

describe("file d'alertes : regroupement", () => {
  it("[B-395] 10 échecs de même cause en 1 h → une seule alerte, compteur 10", async () => {
    const h = { t: 0 };
    const { alertes, depot } = memoire(h);
    const { n } = notifs();
    for (let i = 0; i < 10; i++) {
      h.t = i * 6 * 60_000;
      await ouvrirAlerte(depot, n, T1, entree);
    }
    expect(alertes).toHaveLength(1);
    expect(alertes[0]!.occ).toHaveLength(10);
  });
  it("[B-395] même cause 2 h 01 après → une relance", async () => {
    const h = { t: 0 };
    const { alertes, depot } = memoire(h);
    const { n, envoyees } = notifs();
    await ouvrirAlerte(depot, n, T1, entree);
    h.t = 2 * H + 60_000;
    const r = await ouvrirAlerte(depot, n, T1, entree);
    expect(r.relance).toBe(true);
    expect(envoyees).toEqual(["relance:a1"]);
    expect(alertes[0]!.occ.filter((o) => o.relance)).toHaveLength(1);
  });
  it("[B-395] même cause 1 h 59 après la dernière relance → occurrence sans relance", async () => {
    const h = { t: 0 };
    const { depot } = memoire(h);
    const { n, envoyees } = notifs();
    await ouvrirAlerte(depot, n, T1, entree);
    h.t = 2 * H;
    await ouvrirAlerte(depot, n, T1, entree);
    h.t = 2 * H + 119 * 60_000;
    const r = await ouvrirAlerte(depot, n, T1, entree);
    expect(r.relance).toBe(false);
    expect(envoyees).toEqual(["relance:a1"]);
    expect(DELAI_RELANCE_MS).toBe(7_200_000);
  });
  it("[B-427] 40 messages identiques → une ligne", async () => {
    const { alertes, depot } = memoire({ t: 0 });
    const { n } = notifs();
    for (let i = 0; i < 40; i++) await ouvrirAlerte(depot, n, T1, entree);
    expect(alertes).toHaveLength(1);
  });
  it("[B-427] même cause, même connecteur, deux instances → une alerte, deux occurrences ; un autre connecteur → une autre alerte ; un autre client aussi", async () => {
    const { alertes, depot } = memoire({ t: 0 });
    const { n } = notifs();
    await ouvrirAlerte(depot, n, T1, { ...entree, instanceId: "i1" });
    await ouvrirAlerte(depot, n, T1, { ...entree, instanceId: "i2" });
    expect(alertes).toHaveLength(1);
    expect(alertes[0]!.occ).toHaveLength(2);
    await ouvrirAlerte(depot, n, T1, { ...entree, cause: { cause: "timeout", connecteur: "agenda" } });
    await ouvrirAlerte(depot, n, T2, entree);
    expect(alertes).toHaveLength(3);
  });
});

describe("file d'alertes : retour au vert", () => {
  it("[B-395] retour au vert → alerte close et une seule notification de retour", async () => {
    const { alertes, depot } = memoire({ t: 0 });
    const { n, envoyees } = notifs();
    await ouvrirAlerte(depot, n, T1, entree);
    await retablirAlerte(depot, n, T1, entree.cause);
    expect(alertes[0]!.etat).toBe("close");
    expect(alertes[0]!.cloture).toEqual({ raison: "retabli", auteur: "supervision" });
    expect(envoyees).toEqual(["retabli:a1"]);
  });
  it("[B-395] un deuxième retour au vert (rejeu) n'envoie aucune notification", async () => {
    const { depot } = memoire({ t: 0 });
    const { n, envoyees } = notifs();
    await ouvrirAlerte(depot, n, T1, entree);
    await retablirAlerte(depot, n, T1, entree.cause);
    await retablirAlerte(depot, n, T1, entree.cause);
    expect(envoyees).toEqual(["retabli:a1"]);
  });
  it("[B-395] la notification « rétabli » part après la validation, jamais si la transaction échoue", async () => {
    const m = memoire({ t: 0 });
    const { n, envoyees } = notifs();
    await ouvrirAlerte(m.depot, n, T1, entree);
    m.echoue.valeur = true;
    await expect(retablirAlerte(m.depot, n, T1, entree.cause)).rejects.toThrow("transaction annulée");
    expect(envoyees).toEqual([]);
  });
  it("[B-395] vers vert → retablir ; vers orange ou rouge → ouverture avec la gravité correspondante", async () => {
    const m = memoire({ t: 0 });
    const { n, envoyees } = notifs();
    const vu: string[] = [];
    const depot: DepotFile & DepotCycle = { ...m.depot, ouvrirOuCompter: async (t, e) => { vu.push(e.gravite); return m.depot.ouvrirOuCompter(t, e); } };
    const base = { tenantId: T1, instanceId: null, raisons: ["connexion_expiree"], connecteur: "mail" };
    await surChangementSante(depot, n, { ...base, avant: "vert", apres: "orange" });
    await surChangementSante(depot, n, { ...base, avant: "orange", apres: "rouge" });
    expect(vu).toEqual(["avertissement", "critique"]);
    await surChangementSante(depot, n, { ...base, avant: "rouge", apres: "vert" });
    expect(m.alertes[0]!.etat).toBe("close");
    expect(envoyees).toEqual(["retabli:a1"]);
  });
});

describe("file d'alertes : types « service »", () => {
  it("[C-097] les types connexion_expiree, palier_80, quota_80, incident, violation sont « service »", () => {
    for (const t of ["connexion_expiree", "palier_80", "quota_80", "incident", "violation"]) expect(TYPES_SERVICE).toContain(t);
  });
  it("[C-097] un type hors de TYPES_SERVICE est refusé à l'ouverture", async () => {
    const { alertes, depot } = memoire({ t: 0 });
    await expect(ouvrirAlerte(depot, notifs().n, T1, { ...entree, type: "prospection" })).rejects.toThrow("type d'alerte inconnu");
    expect(alertes).toHaveLength(0);
  });
  it("[C-217] la file n'importe pas envois/exclusions.ts et TYPES_SERVICE est disjointe de ENVOIS_COMMERCIAUX", () => {
    const source = ["ouvrir.ts", "cycle.ts", "regrouper.ts"].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8")).join("\n");
    expect(source).not.toMatch(/exclusions/);
    for (const t of ["prospection", "relance_commerciale", "newsletter", "proposition_commerciale"]) expect(TYPES_SERVICE).not.toContain(t);
  });
});

describe("file d'alertes : cycle de vie", () => {
  it("[B-031] clore exige une raison de la liste fermée ; un commentaire fait 1 à 500 caractères", async () => {
    const { depot } = memoire({ t: 0 });
    expect(RAISONS_CLOTURE).toContain("traitee");
    await expect(clore(depot, T1, "a1", "pas dans la liste", "equipe@exemple.fr")).rejects.toBeInstanceOf(ErreurCycle);
    await expect(commenter(depot, T1, "a1", "   ", "equipe@exemple.fr")).rejects.toBeInstanceOf(ErreurCycle);
    await expect(commenter(depot, T1, "a1", "x".repeat(501), "equipe@exemple.fr")).rejects.toBeInstanceOf(ErreurCycle);
  });
});

// Fausse connexion : enregistre les requêtes dans l'ordre. Prouve la forme du SQL sans base (l'essai réel est dans la CI d'intégration).
function fauxPool(lignes: Record<string, unknown[]>) {
  const requetes: string[] = [];
  const client = {
    async query(texte: string) {
      requetes.push(texte);
      const cle = Object.keys(lignes).find((k) => texte.includes(k));
      return { rows: cle ? lignes[cle] : [], rowCount: cle ? lignes[cle]!.length : 0 };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, requetes };
}

describe("file d'alertes : requêtes SQL", () => {
  it("[B-427] l'ouverture répète le prédicat de l'index partiel, verrouille l'alerte avant l'occurrence et tient en une transaction", async () => {
    const { pool, requetes } = fauxPool({ "RETURNING id": [{ id: "a1" }], "FOR UPDATE": [{ id: "a1", cree_le: new Date(0) }], "AS calme": [{ calme: false }] });
    const r = await depotSqlFile(pool).ouvrirOuCompter(T1, { type: "connexion_expiree", gravite: "avertissement", regle: "sante_orange", cle: "timeout:mail", cause: "timeout", instanceId: null });
    expect(r).toEqual({ alerteId: "a1", nouvelle: true, relance: false });
    const tout = requetes.join("\n");
    expect(tout).toContain("ON CONFLICT (tenant_id, cle_regroupement) WHERE cle_regroupement IS NOT NULL AND etat IN ('ouverte','acquittee') DO NOTHING");
    expect(requetes.findIndex((q) => q.includes("FOR UPDATE"))).toBeLessThan(requetes.findIndex((q) => q.includes("INSERT INTO occurrences_alertes")));
    expect(requetes[0]).toBe("BEGIN");
    expect(requetes.at(-1)).toBe("COMMIT");
    expect(requetes.some((q) => q.includes("set_config('app.acteur'"))).toBe(true);
  });
  it("[B-395] le retour au vert verrouille, clôture avec la raison « retabli » puis passe à close, dans cet ordre", async () => {
    const { pool, requetes } = fauxPool({ "FOR UPDATE": [{ id: "a1" }] });
    const { depotSqlCycle } = await import("./cycle.js");
    expect(await depotSqlCycle(pool).retablir(T1, "timeout:mail")).toEqual({ alerteId: "a1" });
    const i = (m: string) => requetes.findIndex((q) => q.includes(m));
    expect(i("FOR UPDATE")).toBeLessThan(i("INSERT INTO clotures_alertes"));
    expect(i("INSERT INTO clotures_alertes")).toBeLessThan(i("SET etat = 'close'"));
  });
});
