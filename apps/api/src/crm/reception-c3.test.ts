import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { empreinteEmail, identifiantEvenementC3 } from "../../../../packages/contrats/src/c3/evenements-crm-vers-console.js";
import { EN_TETES, signer } from "../../../../packages/contrats/src/commun/signature.js";
import { ROUTES_C3 } from "../../../../packages/contrats/src/c3/lecture-entreprise.js";
import { brancherErreurs } from "../plugins/erreurs.js";
import { construireServeur } from "../serveur.js";
import { routeCrm, ESSAIS_C3 } from "../routes/crm.js";
import { depotEnMemoire } from "./faits/depot-memoire.js";
import { creerDepotSql } from "./faits/depot-sql.js";
import { creerRecepteurC3 } from "./recepteur-c3.js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIREN = "812345676";
const ADRESSE = { ligne1: "1 rue des Essais", codePostal: "75001", ville: "Paris", pays: "FR" as const };
let n = 1000;
const evt = (type: string, payload: object, crm = "crm-lemoine") => ({
  event_id: identifiantEvenementC3(type, randomUUID()),
  schema_version: 1 as const,
  occurred_at: "2026-11-02T10:00:00Z",
  emitted_at: "2026-11-02T10:00:01Z",
  sequence: ++n,
  producer: "axion-crm" as const,
  subject_ref: { crmCompanyId: crm },
  event_type: type,
  payload,
});
const devenue = () => evt("entreprise.devenue_cliente", { crmCompanyId: "crm-lemoine", siren: SIREN, raisonSociale: "Lemoine Rénovation", adresse: ADRESSE, contacts: [{ nom: "Camille Test", email: "camille.test@exemple.fr" }] });
const retrait = (email = "camille.test@exemple.fr") => evt("consentement.retire", { personKey: "p-1", emailEmpreinte: empreinteEmail(email) });

function monter(signaler: (a: { type: string; reference: string }) => Promise<void> = async () => undefined) {
  const depot = depotEnMemoire();
  const r = creerRecepteurC3({ depot, alertes: { signaler } });
  return { depot, r };
}

describe("rangement du fait avant la file (récepteur C3)", () => {
  const MAINTENANT = Math.floor(Date.now() / 1000);
  const CLE = { kid: "crm-essai", secret: Buffer.alloc(32, 7) };
  function route() {
    const { depot, r } = monter();
    const journal: string[] = [];
    const ajouts: { donnees: unknown; opts: Record<string, unknown> | undefined }[] = [];
    let refuser = false;
    const serveur = Fastify();
    brancherErreurs(serveur);
    routeCrm(serveur, {
      entrant: { cles: { clesAcceptees: async () => [CLE] }, memoire: { set: async () => "OK" }, actif: () => true, maintenant: () => MAINTENANT },
      recepteur: { recevoir: async (brut) => { journal.push("rangé"); return r.recevoir(brut); } },
      file: { add: async (_n, donnees, opts) => { journal.push("en file"); if (refuser) throw new Error("valkey_indisponible"); ajouts.push({ donnees, opts }); } },
    });
    const base = { "content-type": "application/json", "idempotency-key": randomUUID(), [EN_TETES.cle]: CLE.kid, [EN_TETES.horodatage]: String(MAINTENANT) };
    const envoyer = (corps: string) => serveur.inject({ method: "POST", url: ROUTES_C3.crmVersConsole.chemin, payload: corps, headers: { ...base, [EN_TETES.signature]: signer(CLE.secret.toString("base64"), String(MAINTENANT), "POST", ROUTES_C3.crmVersConsole.chemin, corps) } });
    return { depot, r, journal, ajouts, envoyer, refuserFile: () => (refuser = true) };
  }

  it("[C-331] le fait est rangé en base AVANT la mise en file ; le job ne porte que l'identifiant", async () => {
    const { journal, ajouts, envoyer, depot } = route();
    const f = devenue();
    expect((await envoyer(JSON.stringify(f))).statusCode).toBe(200);
    expect(journal).toEqual(["rangé", "en file"]);
    expect(ajouts[0]?.donnees).toEqual({ tenantId: "00000000-0000-0000-0000-000000000001", eventId: f.event_id });
    expect(ajouts[0]?.opts).toMatchObject({ jobId: f.event_id });
    expect(depot.faitsRecus()).toBe(1);
  });

  it("[C-331] si la file refuse, le fait reste rangé ; le rejeu du CRM ne le range pas deux fois", async () => {
    const { envoyer, refuserFile, depot } = route();
    const f = devenue();
    refuserFile();
    expect((await envoyer(JSON.stringify(f))).statusCode).toBeGreaterThanOrEqual(500);
    expect(depot.faitsRecus()).toBe(1);
    expect((await envoyer(JSON.stringify(f))).statusCode).toBeGreaterThanOrEqual(500);
    expect(depot.faitsRecus()).toBe(1);
  });

  it("[C-331] le nombre d'essais BullMQ est fixé (borné, attente exponentielle)", async () => {
    const { envoyer, ajouts } = route();
    await envoyer(JSON.stringify(devenue()));
    expect(ESSAIS_C3).toBe(5);
    expect(ajouts[0]?.opts).toMatchObject({ attempts: ESSAIS_C3, backoff: { type: "exponential", delay: expect.any(Number) } });
  });

  it("[C-331] une séquence au-delà de 2^53-1 est refusée avant d'être rangée", async () => {
    const { r, depot } = monter();
    await expect(r.recevoir({ ...retrait(), sequence: 2 ** 53 })).rejects.toThrow();
    expect(depot.faitsRecus()).toBe(0);
  });

  it("[C-331] le travailleur lit le fait par son identifiant et range les contacts hors de la file, sans créer d'organisation", async () => {
    const { r, depot } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: null });
    const f = devenue();
    await r.recevoir(f);
    expect(await r.traiterParId(f.event_id)).toMatchObject({ doublon: false, resultat: "traite" });
    expect(depot.organisations()).toHaveLength(1);
    expect(depot.contacts(ORG)).toEqual(["camille.test@exemple.fr"]);
    expect(await r.traiterParId(f.event_id)).toEqual({ doublon: true });
    expect(depot.contacts(ORG)).toHaveLength(1);
  });

  it("[C-458] un retrait reçu avant l'import exclut le contact importé ensuite (exclusion par empreinte, données conservées)", async () => {
    const { r, depot } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: null });
    await r.traiter(retrait());
    const f = devenue();
    await r.recevoir(f);
    await r.traiterParId(f.event_id);
    expect(depot.contacts(ORG)).toEqual(["camille.test@exemple.fr"]);
    expect(depot.exclusions(ORG)).toEqual([empreinteEmail("camille.test@exemple.fr")]);
  });
});

describe("alertes : confirmées une à une, balayage sans nouvel essai BullMQ", () => {
  it("[C-458] signaler lève : traiter ne lève pas (aucun essai BullMQ de plus), l'alerte reste non confirmée, le balayage la renvoie puis la confirme", async () => {
    let panne = true;
    const envoyees: string[] = [];
    const { r, depot } = monter(async (a) => {
      if (panne) throw new Error("webhook_indisponible");
      envoyees.push(`${a.type}:${a.reference}`);
    });
    await expect(r.traiter(retrait())).resolves.toMatchObject({ doublon: false, resultat: "traite" });
    expect(depot.alertesRangees().filter((a) => !a.confirmee).length).toBeGreaterThan(0);
    panne = false;
    const bilan = await r.balayerAlertes();
    expect(bilan.renvoyees).toBe(envoyees.length);
    expect(envoyees.length).toBeGreaterThan(0);
    expect(depot.alertesRangees().every((a) => a.confirmee)).toBe(true);
    expect((await r.balayerAlertes()).renvoyees).toBe(0);
  });

  it("[C-458] une alerte qui échoue n'empêche pas les suivantes ; le balayage est borné par sa limite", async () => {
    const vues: string[] = [];
    let echouer = true;
    const { r, depot } = monter(async (a) => {
      if (echouer && vues.length === 0) { vues.push("x"); throw new Error("panne"); }
      vues.push(a.type);
    });
    await r.traiter(evt("effacement.demande", { personKey: "p-2", emailEmpreinte: empreinteEmail("autre.test@exemple.fr") }));
    echouer = false;
    expect(depot.alertesRangees().filter((a) => !a.confirmee)).toHaveLength(1);
    expect(depot.alertesRangees().filter((a) => a.confirmee)).toHaveLength(1);
    expect((await r.balayerAlertes(1)).renvoyees).toBe(1);
    expect((await r.balayerAlertes(10)).renvoyees).toBe(0);
    expect(depot.alertesRangees().every((a) => a.confirmee)).toBe(true);
  });
});

describe("adaptateur SQL du dépôt C3 (sans base : requêtes enregistrées)", () => {
  function faussePool() {
    const requetes: { texte: string; valeurs: unknown[] }[] = [];
    const client = { query: async (texte: string, valeurs: unknown[] = []) => (requetes.push({ texte, valeurs }), { rows: [], rowCount: 0 }), release: () => undefined };
    return { requetes, pool: { connect: async () => client, query: client.query } as unknown as pg.Pool };
  }

  it("[C-458] exclure range (portée, empreinte) sans lire les contacts ; l'opposition est globale ; idempotent", async () => {
    const app = faussePool();
    const depot = creerDepotSql({ app: app.pool, equipe: faussePool().pool });
    const empreinte = empreinteEmail("camille.test@exemple.fr");
    await depot.transaction(async (tx) => {
      await tx.exclure({ empreinte, genre: "desabonnement", crmCompanyId: "crm-lemoine" });
      await tx.exclure({ empreinte, genre: "opposition", crmCompanyId: "crm-lemoine" });
    });
    const insertions = app.requetes.filter((q) => /INSERT INTO exclusions_c3/i.test(q.texte));
    expect(insertions).toHaveLength(2);
    expect(insertions.every((q) => /ON CONFLICT[^;]*DO NOTHING/i.test(q.texte))).toBe(true);
    expect(insertions.map((q) => q.valeurs.slice(-3))).toEqual([["crm-lemoine", empreinte, "desabonnement"], ["*", empreinte, "opposition"]]);
    expect(app.requetes.some((q) => /contacts/i.test(q.texte))).toBe(false);
  });

  it("[C-458] chaque écriture est précédée du client actif (set_config local) et la transaction est validée une fois", async () => {
    const app = faussePool();
    const depot = creerDepotSql({ app: app.pool, equipe: faussePool().pool });
    await depot.transaction((tx) => tx.exclure({ empreinte: empreinteEmail("a.test@exemple.fr"), genre: "desabonnement", crmCompanyId: "crm-lemoine" }));
    const textes = app.requetes.map((q) => q.texte);
    expect(textes[0]).toMatch(/^BEGIN/);
    expect(textes.filter((t) => /set_config\('app\.tenant_id'[^)]*, true\)/.test(t)).length).toBeGreaterThan(0);
    expect(textes.filter((t) => /^COMMIT/.test(t))).toHaveLength(1);
  });

  it("[C-458] l'adaptateur n'émet ni DELETE ni TRUNCATE (une opposition est une exclusion durable, rien n'est supprimé)", () => {
    const source = readFileSync(fileURLToPath(new URL("./faits/depot-sql.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE)\b/i);
  });
});

describe("migration du récepteur C3", () => {
  const dossier = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const fichier = readdirSync(dossier).find((f) => f.startsWith("0015_"));
  const sql = fichier ? readFileSync(`${dossier}${fichier}`, "utf8") : "";
  const tables = ["contenus_c3", "exclusions_c3", "alertes_c3", "donnees_crm_c3"];

  it("[C-458] la migration 0015 existe et crée les tables du récepteur C3", () => {
    expect(fichier).toBeDefined();
    for (const t of tables) expect(sql).toContain(`CREATE TABLE "${t}"`);
  });

  it("[C-458] RLS activée ET forcée, unicité commençant par tenant_id, aucun DELETE ni TRUNCATE accordé", () => {
    for (const t of tables) {
      expect(sql).toContain(`ALTER TABLE "public"."${t}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "public"."${t}" FORCE ROW LEVEL SECURITY`);
    }
    for (const u of sql.matchAll(/UNIQUE\("([a-z_]+)"/g)) expect(u[1]).toBe("tenant_id");
    expect(sql).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
  });
});

describe("branchement dans serveur.ts", () => {
  it("[C-331] sans dépôt C3 fourni, la route du CRM n'est pas branchée ; fournie, elle l'est mais l'interrupteur reste fermé (503)", async () => {
    const sans = construireServeur();
    expect((await sans.inject({ method: "POST", url: ROUTES_C3.crmVersConsole.chemin, payload: "{}" })).statusCode).toBe(404);
    const { r } = monter();
    const avec = construireServeur({ crm: { entrant: { cles: { clesAcceptees: async () => [] }, memoire: { set: async () => "OK" }, actif: () => false }, recepteur: r, file: { add: async () => undefined } } });
    expect((await avec.inject({ method: "POST", url: ROUTES_C3.crmVersConsole.chemin, payload: "{}" })).statusCode).toBe(503);
  });
});
