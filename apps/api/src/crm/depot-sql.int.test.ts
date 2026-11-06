import { writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { empreinteEmail, identifiantEvenementC3 } from "../../../../packages/contrats/src/c3/evenements-crm-vers-console.js";
import { avecClient } from "../db/client-actif.js";
import { migrer } from "../db/migrer.js";
import { PLATEFORME_ID } from "../db/schema/aides.js";
import { creerDepotSql } from "./faits/depot-sql.js";
import { cibleDEnvoiCrm } from "./faits/fusion.js";
import { creerRecepteurC3 } from "./recepteur-c3.js";

// Le rapport de la CI est un JSON hors du journal : un essai en échec est écrit par writeSync(2, …), lisible dans le journal du job.
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

// Adaptateur SQL du récepteur C3 sur la vraie base (socle lancé par ops/socle/lancer.sh, job socle-integration) : reprend les tests [C-331], [C-457] et [C-458] du dépôt en mémoire.
// Même repérage du socle que les autres essais : variables SOCLE_PG_* si présentes, sinon les conteneurs du projet « socle ».
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cible(service: string, port: number, surcharge: string | undefined): { host: string; port: number } {
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  const modele = '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}';
  return { host: docker("inspect", "-f", modele, conteneur(service)), port };
}
function secret(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const variables = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n");
  const ligne = variables.find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="));
  if (!ligne) throw new Error("mot de passe de test introuvable");
  return ligne.slice("SOCLE_PG_MOT_DE_PASSE=".length);
}
const SECRET = secret();
const DIRECT = cible("postgres", 5432, process.env["SOCLE_PG_DIRECT"]);
const PGBOUNCER = cible("pgbouncer", 6432, process.env["SOCLE_PG_PGBOUNCER"]);
const motDePasseDe = (role: string) => createHash("sha256").update(`${SECRET}/${role}`).digest("hex");
const ouverts: pg.Pool[] = [];
const pool = (voie: { host: string; port: number }, user: string) => {
  const p = new pg.Pool({ ...voie, user, database: "console", password: motDePasseDe(user), max: 8, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  ouverts.push(p);
  return p;
};
const app = pool(PGBOUNCER, "console_app");
const equipe = pool(PGBOUNCER, "console_equipe");
const depot = creerDepotSql({ app, equipe });
const ACTEUR = { acteur: "agent-essai", ip: "192.0.2.17" };

// SIREN valides (clé de Luhn) tirés au hasard : les essais partagent la base.
function siren(): string {
  const huit = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  for (let c = 0; c < 10; c++) {
    const s = `${huit}${c}`;
    const somme = [...s].reverse().reduce((t, ch, i) => t + (i % 2 ? (Number(ch) * 2 > 9 ? Number(ch) * 2 - 9 : Number(ch) * 2) : Number(ch)), 0);
    if (somme % 10 === 0) return s;
  }
  throw new Error("siren");
}
const crm = () => `crm-${randomUUID().slice(0, 8)}`;
let n = 5000;
const evt = (type: string, payload: object, sujet: string) => ({
  event_id: identifiantEvenementC3(type, randomUUID()), schema_version: 1 as const, occurred_at: "2026-11-02T10:00:00Z", emitted_at: "2026-11-02T10:00:01Z",
  sequence: ++n, producer: "axion-crm" as const, subject_ref: { crmCompanyId: sujet }, event_type: type, payload,
});
const ADRESSE = { ligne1: "1 rue des Essais", codePostal: "75001", ville: "Paris", pays: "FR" as const };
const devenue = (sujet: string, s: string, email: string) => evt("entreprise.devenue_cliente", { crmCompanyId: sujet, siren: s, raisonSociale: "Lemoine Rénovation", adresse: ADRESSE, contacts: [{ nom: "Camille Test", email }] }, sujet);
const retrait = (type: "consentement.retire" | "effacement.demande", sujet: string, email: string) => evt(type, { personKey: "p-1", emailEmpreinte: empreinteEmail(email) }, sujet);
const creerOrg = async (s: string, crmId: string | null = null) => {
  const id = randomUUID();
  await avecClient(app, id, (c) => c.query("INSERT INTO organisations (tenant_id, id, console_client_id, raison_sociale, siren, crm_company_id) VALUES ($1, $1, $1, 'Lemoine Rénovation', $2, $3)", [id, s, crmId]), ACTEUR);
  return id;
};
const lire = async (texte: string, valeurs: unknown[]) => (await equipe.query(texte, valeurs)).rows as Record<string, unknown>[];
const alertesSignalees: string[] = [];
let panne = false;
const recepteur = creerRecepteurC3({ depot, alertes: { signaler: async (a) => { if (panne) throw new Error("webhook_indisponible"); alertesSignalees.push(`${a.type}:${a.reference}`); } } });
const recevoirEtTraiter = async (f: ReturnType<typeof evt>) => (await recepteur.recevoir(f), recepteur.traiterParId(f.event_id));

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => void (await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)))));

describe("récepteur C3 sur la base réelle", () => {
  it("[C-331] un fait devenue_cliente signé lie la fiche existante sans créer d'organisation et range les contacts hors de la file", async () => {
    const s = siren(), c = crm(), email = `contact.${randomUUID().slice(0, 6)}@exemple.fr`;
    const org = await creerOrg(s);
    const f = devenue(c, s, email);
    expect(await recepteur.recevoir(f)).toEqual({ eventId: f.event_id });
    expect(await recepteur.traiterParId(f.event_id)).toMatchObject({ doublon: false, resultat: "traite" });
    expect(await lire("SELECT id, crm_company_id FROM organisations WHERE siren = $1", [s])).toEqual([{ id: org, crm_company_id: c }]);
    expect(await lire("SELECT etat FROM liens_crm WHERE tenant_id = $1 AND crm_company_id = $2", [org, c])).toEqual([{ etat: "actif" }]);
    expect((await lire("SELECT email FROM contacts WHERE tenant_id = $1", [org])).map((r) => r["email"])).toEqual([email]);
    expect(await recepteur.traiterParId(f.event_id)).toEqual({ doublon: true });
    expect(await lire("SELECT 1 FROM contacts WHERE tenant_id = $1", [org])).toHaveLength(1);
    expect(await lire("SELECT resultat FROM faits_recus WHERE tenant_id = $1 AND event_id = $2", [PLATEFORME_ID, f.event_id])).toEqual([{ resultat: "traite" }]);
  });

  it("[C-331] le même fait reçu deux fois n'est rangé qu'une fois (réception idempotente)", async () => {
    const f = retrait("consentement.retire", crm(), "a.test@exemple.fr");
    await recepteur.recevoir(f);
    await recepteur.recevoir(f);
    expect(await lire("SELECT 1 FROM faits_recus WHERE tenant_id = $1 AND event_id = $2", [PLATEFORME_ID, f.event_id])).toHaveLength(1);
    expect(await lire("SELECT 1 FROM contenus_c3 WHERE tenant_id = $1 AND event_id = $2", [PLATEFORME_ID, f.event_id])).toHaveLength(1);
  });

  it("[C-457] après fiche.fusionnee, l'ancien lien est conservé « absorbé » et la cible d'envoi devient la fiche gardée", async () => {
    const absorbee = crm(), gardee = crm();
    const org = await creerOrg(siren(), absorbee);
    await avecClient(app, org, (c) => c.query("INSERT INTO liens_crm (tenant_id, id, organisation_id, crm_company_id) VALUES ($1, gen_random_uuid(), $1, $2)", [org, absorbee]), ACTEUR);
    expect(await recevoirEtTraiter(evt("fiche.fusionnee", { crmCompanyIdAbsorbee: absorbee, crmCompanyIdGardee: gardee }, gardee))).toMatchObject({ resultat: "traite" });
    expect(await lire("SELECT crm_company_id, etat, absorbe_par FROM liens_crm WHERE tenant_id = $1 ORDER BY crm_company_id", [org])).toEqual(
      [...[{ crm_company_id: absorbee, etat: "absorbe", absorbe_par: gardee }, { crm_company_id: gardee, etat: "actif", absorbe_par: null }]].sort((a, b) => a.crm_company_id.localeCompare(b.crm_company_id)),
    );
    expect(await depot.transaction((tx) => cibleDEnvoiCrm(tx, absorbee))).toBe(gardee);
    expect(await depot.transaction((tx) => cibleDEnvoiCrm(tx, gardee))).toBe(gardee);
  });

  it("[C-457] apporteur.rattache range l'apporteur sur la fiche liée, une seule fois", async () => {
    const c = crm();
    const org = await creerOrg(siren(), c);
    const f = evt("apporteur.rattache", { crmCompanyId: c, apporteurId: "apporteur-essai" }, c);
    await recevoirEtTraiter(f);
    await recepteur.traiterParId(f.event_id);
    expect((await lire("SELECT contenu FROM donnees_crm_c3 WHERE tenant_id = $1 AND sorte = 'apporteur'", [org])).map((r) => r["contenu"])).toEqual([{ apporteurId: "apporteur-essai" }]);
  });

  it("[C-458] un retrait reçu avant l'import exclut le contact importé ensuite ; un envoi commercial réel vers lui est refusé", async () => {
    const s = siren(), c = crm(), email = `contact.${randomUUID().slice(0, 6)}@exemple.fr`;
    await recevoirEtTraiter(retrait("consentement.retire", c, email));
    const org = await creerOrg(s);
    await recevoirEtTraiter(devenue(c, s, email));
    expect((await lire("SELECT email FROM contacts WHERE tenant_id = $1", [org])).map((r) => r["email"])).toEqual([email]);
    expect(await depot.estExclue(org, empreinteEmail(email))).toBe(true);
    // Le désabonnement est propre au client du sujet : un autre client n'est pas touché.
    const autre = await creerOrg(siren(), crm());
    expect(await depot.estExclue(autre, empreinteEmail(email))).toBe(false);
  });

  it("[C-458] une opposition (effacement demandé) vaut pour tous les clients ; les données sont conservées, rien n'est supprimé", async () => {
    const email = `personne.${randomUUID().slice(0, 6)}@exemple.fr`;
    const a = await creerOrg(siren(), crm()), b = await creerOrg(siren(), crm());
    await avecClient(app, a, (c) => c.query("INSERT INTO contacts (tenant_id, id, organisation_id, nom, email) VALUES ($1, gen_random_uuid(), $1, 'Camille Test', $2)", [a, email]), ACTEUR);
    await recevoirEtTraiter(retrait("effacement.demande", crm(), email));
    expect(await depot.estExclue(a, empreinteEmail(email))).toBe(true);
    expect(await depot.estExclue(b, empreinteEmail(email))).toBe(true);
    expect(await lire("SELECT 1 FROM contacts WHERE tenant_id = $1 AND email = $2", [a, email])).toHaveLength(1);
    await expect(avecClient(app, PLATEFORME_ID, (c) => c.query("DELETE FROM exclusions_c3 WHERE tenant_id = $1", [PLATEFORME_ID]), ACTEUR)).rejects.toMatchObject({ code: "42501" });
    // Un client ne lit pas la liste de la plateforme.
    expect((await avecClient(app, a, (c) => c.query("SELECT 1 FROM exclusions_c3"), ACTEUR)).rowCount).toBe(0);
  });

  it("[C-458] l'exclusion suit la fiche après une fusion (fiche gardée ou absorbée)", async () => {
    const absorbee = crm(), gardee = crm(), email = `suivi.${randomUUID().slice(0, 6)}@exemple.fr`;
    const org = await creerOrg(siren(), absorbee);
    await recevoirEtTraiter(retrait("consentement.retire", absorbee, email));
    await recevoirEtTraiter(evt("fiche.fusionnee", { crmCompanyIdAbsorbee: absorbee, crmCompanyIdGardee: gardee }, gardee));
    expect(await depot.estExclue(org, empreinteEmail(email))).toBe(true);
    const e2 = `suivi2.${randomUUID().slice(0, 6)}@exemple.fr`;
    await recevoirEtTraiter(retrait("consentement.retire", gardee, e2));
    expect(await depot.estExclue(org, empreinteEmail(e2))).toBe(true);
  });

  it("[C-458] signaler lève : l'alerte reste rangée non confirmée, le balayage la renvoie puis la confirme", async () => {
    panne = true;
    const f = retrait("effacement.demande", crm(), `x.${randomUUID().slice(0, 6)}@exemple.fr`);
    await recepteur.recevoir(f);
    await expect(recepteur.traiterParId(f.event_id)).resolves.toMatchObject({ resultat: "traite" });
    expect(await lire("SELECT type FROM alertes_c3 WHERE tenant_id = $1 AND event_id = $2 AND confirmee_le IS NULL", [PLATEFORME_ID, f.event_id])).toHaveLength(2);
    panne = false;
    const avant = alertesSignalees.length;
    await recepteur.balayerAlertes(1000);
    expect(alertesSignalees.length - avant).toBeGreaterThanOrEqual(2);
    expect(await lire("SELECT 1 FROM alertes_c3 WHERE tenant_id = $1 AND event_id = $2 AND confirmee_le IS NULL", [PLATEFORME_ID, f.event_id])).toHaveLength(0);
    // Rejeu du fait : plus rien à renvoyer.
    const apres = alertesSignalees.length;
    await recepteur.traiterParId(f.event_id);
    expect(alertesSignalees.length).toBe(apres);
  });

  it("[C-458] atomicité : un effet qui échoue après rangerFait ne laisse ni exclusion ni alerte, le fait reste non traité", async () => {
    const email = `y.${randomUUID().slice(0, 6)}@exemple.fr`;
    const f = retrait("effacement.demande", crm(), email);
    const casse = { transaction: <T,>(fn: (tx: Parameters<Parameters<typeof depot.transaction>[0]>[0]) => Promise<T>) => depot.transaction((tx) => fn({ ...tx, marquerTraite: async () => { throw new Error("effet en échec"); } })) };
    const r = creerRecepteurC3({ depot: casse, alertes: { signaler: async () => undefined } });
    await r.recevoir(f);
    await expect(r.traiterParId(f.event_id)).rejects.toThrow("effet en échec");
    expect(await lire("SELECT 1 FROM exclusions_c3 WHERE tenant_id = $1 AND empreinte = $2", [PLATEFORME_ID, empreinteEmail(email)])).toHaveLength(0);
    expect(await lire("SELECT 1 FROM alertes_c3 WHERE tenant_id = $1 AND event_id = $2", [PLATEFORME_ID, f.event_id])).toHaveLength(0);
    expect(await lire("SELECT traite_le FROM faits_recus WHERE tenant_id = $1 AND event_id = $2", [PLATEFORME_ID, f.event_id])).toEqual([{ traite_le: null }]);
    // Un nouvel essai (BullMQ) traite le fait.
    await expect(recepteur.traiterParId(f.event_id)).resolves.toMatchObject({ doublon: false });
  });
});
