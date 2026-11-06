import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, EXCEPTIONS_UNICITE, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient, avecEquipe } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Tables des canaux (T2-02) : boîte d'envoi, faits reçus, liens CRM, file « à trancher », exclusions. Socle lancé par ops/socle/lancer.sh (job socle-integration).
// Les essais tournent en parallèle sur une base partagée : identifiants de client tirés au hasard.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) =>
  docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
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
const ouverts: { end(): Promise<void> }[] = [];
function pool(voie: { host: string; port: number }, user: string, max: number): pg.Pool {
  const p = new pg.Pool({ ...voie, user, database: "console", password: motDePasseDe(user), max, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  ouverts.push(p);
  return p;
}

const migration = pool(DIRECT, "console_migration", 3);
const app = pool(PGBOUNCER, "console_app", 40);
const OPTIONS = { rolesApplication: /^(console|moteur)_(app|equipe)$/ };
const requete: Requete = async (sql) => (await migration.query(`SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`)).rows[0]?.["r"] as Record<string, unknown>[];
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };
const equipe = pool(PGBOUNCER, "console_equipe", 3);
const empreinte = (email: string) => createHash("sha256").update(email.toLowerCase()).digest("hex");

// Les écritures auditées passent par le verrou du journal : une attente trop longue (55P03) est rejouée pour les mises en place.
async function ecrire<T>(...args: Parameters<typeof avecClient<T>>): Promise<T> {
  for (let essai = 1; ; essai++) {
    try {
      return await avecClient(...args);
    } catch (e) {
      if (!["55P03", "40P01"].includes((e as { code?: string }).code ?? "") || essai >= 4) throw e;
    }
  }
}
// Écritures directes de l'équipe sur les tables auditées (T2-03) : même attente du verrou du journal, même reprise.
async function equipeRejouee(texte: string, valeurs: unknown[] = []) {
  for (let essai = 1; ; essai++) {
    const c = await equipe.connect();
    try {
      // Les tables de la plateforme sont auditées : une écriture qui porte de l'argent exige un acteur (app.acteur), posé pour la durée de la transaction.
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.acteur', 'agent-essai', true)");
      const r = await c.query(texte, valeurs);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      if (!["55P03", "40P01"].includes((e as { code?: string }).code ?? "") || essai >= 4) throw e;
    } finally {
      c.release();
    }
  }
}
const inserer = (tenant: string, table: string, valeurs: Record<string, unknown>) => {
  const v = { id: randomUUID(), tenant_id: tenant, ...valeurs };
  const cles = Object.keys(v);
  return ecrire(app, tenant, async (c) => (await c.query(`INSERT INTO ${table} (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, Object.values(v))).rows[0] as Record<string, unknown>, APPELANT);
};
const creerOrg = (id: string) => inserer(id, "organisations", { id, console_client_id: id, raison_sociale: "Boulangerie Rivoire" });
const envoi = (A: string, extra: Record<string, unknown> = {}) =>
  inserer(A, "boite_envoi", { destination: "crm", route: "/api/v1/evenements", methode: "POST", corps: JSON.stringify({ type: "essai" }), cle_anti_doublon: randomUUID(), empreinte_corps: empreinte("corps"), ...extra });
const fait = (A: string, extra: Record<string, unknown> = {}) => inserer(A, "faits_recus", { source: "hub", event_id: randomUUID(), type: "essai", sequence: 1, sujet: "sujet-essai", ...extra });
const exclusion = (A: string, extra: Record<string, unknown> = {}) => inserer(A, "exclusions", { empreinte_email: empreinte(`${randomUUID()}@exemple.fr`), motif: "rebond", source: "retour_rebond", ...extra });
const commune = (extra: Record<string, unknown> = {}) =>
  equipe.query("INSERT INTO exclusions_plateforme (empreinte_email, motif, source, ajoute_par) VALUES ($1, $2, $3, $4) RETURNING *", [extra["empreinte"] ?? empreinte(`${randomUUID()}@exemple.fr`), extra["motif"] ?? "plainte", extra["source"] ?? "rapport_plainte", extra["auteur"] ?? "agent-essai"]);

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

describe("tables des canaux, avec le socle", { timeout: 30_000 }, () => {
  it("[C-535] @anti-doublon deux lignes de boîte d'envoi avec la même clé : la seconde est refusée par la base ; deux clients peuvent garder la même clé", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await Promise.all([creerOrg(A), creerOrg(B)]);
    const cle = randomUUID();
    await envoi(A, { cle_anti_doublon: cle });
    await expect(envoi(A, { cle_anti_doublon: cle })).rejects.toMatchObject({ code: "23505" });
    // Chez B, la même clé passe : l'unicité est par client, elle ne révèle rien d'un autre client.
    await expect(envoi(B, { cle_anti_doublon: cle })).resolves.toMatchObject({ cle_anti_doublon: cle });
    expect((await ecrire(app, A, (c) => c.query("SELECT count(*)::int AS n FROM boite_envoi WHERE cle_anti_doublon = $1", [cle]))).rows[0]?.n).toBe(1);
  });

  it("[C-402] une ligne de boîte d'envoi porte sa destination et son état a_envoyer", async () => {
    const A = randomUUID();
    await creerOrg(A);
    expect(await envoi(A, { destination: "hub" })).toMatchObject({ destination: "hub", etat: "a_envoyer", nombre_essais: 0, prochain_essai: null, derniere_erreur: null, reponse_recue: null });
    await expect(envoi(A, { destination: "ailleurs" })).rejects.toMatchObject({ code: "22P02" });
    await expect(envoi(A, { empreinte_corps: "pas-une-empreinte" })).rejects.toMatchObject({ code: "23514" });
    // La clé et le corps ne se modifient pas après l'insertion ; l'état et la réponse, oui (réponse gardée entière pour le rejeu).
    const ligne = await envoi(A);
    await expect(ecrire(app, A, (c) => c.query("UPDATE boite_envoi SET cle_anti_doublon = $2 WHERE id = $1", [ligne["id"], randomUUID()]))).rejects.toMatchObject({ code: "42501" });
    const reponse = { statut: 200, corps: "x".repeat(5000) };
    const { rows } = await ecrire(app, A, (c) => c.query("UPDATE boite_envoi SET etat = 'envoye', nombre_essais = 1, reponse_recue = $2 WHERE id = $1 RETURNING etat, reponse_recue", [ligne["id"], JSON.stringify(reponse)]));
    expect(rows[0]).toMatchObject({ etat: "envoye", reponse_recue: reponse });
  });

  it("[C-402] @anti-doublon 20 insertions parallèles du même event_id : une seule ligne", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const eventId = randomUUID();
    const resultats = await Promise.allSettled(Array.from({ length: 20 }, () => fait(A, { event_id: eventId })));
    expect(resultats.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of resultats) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "23505" });
    expect((await ecrire(app, A, (c) => c.query("SELECT count(*)::int AS n FROM faits_recus WHERE event_id = $1", [eventId]))).rows[0]?.n).toBe(1);
    // Même event_id mais autre source : un autre fait.
    await expect(fait(A, { event_id: eventId, source: "crm" })).resolves.toMatchObject({ source: "crm" });
  });

  it("[C-402] un lien CRM est unique par client et par crm_company_id, un fait traité garde son résultat", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await inserer(A, "liens_crm", { organisation_id: A, crm_company_id: "crm-essai-1" });
    await expect(inserer(A, "liens_crm", { organisation_id: A, crm_company_id: "crm-essai-1" })).rejects.toMatchObject({ code: "23505" });
    await expect(inserer(A, "liens_crm", { organisation_id: A, crm_company_id: "crm-essai-2", etat: "absorbe" })).rejects.toMatchObject({ code: "23514" });
    await expect(fait(A, { traite_le: new Date().toISOString() })).rejects.toMatchObject({ code: "23514" });
  });

  it("[C-083] une exclusion du client garde une empreinte de 64 caractères hexadécimaux et refuse un e-mail en clair", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const ligne = await exclusion(A, { empreinte_email: empreinte("Contact@Exemple.fr") });
    expect(String(ligne["empreinte_email"])).toMatch(/^[0-9a-f]{64}$/);
    expect(ligne).toMatchObject({ portee: "client", empreinte_email: empreinte("contact@exemple.fr") });
    await expect(exclusion(A, { empreinte_email: "contact@exemple.fr" })).rejects.toMatchObject({ code: "23514" });
    await expect(exclusion(A, { empreinte_email: empreinte("X@exemple.fr").toUpperCase() })).rejects.toMatchObject({ code: "23514" });
    await expect(exclusion(A, { empreinte_email: ligne["empreinte_email"] })).rejects.toMatchObject({ code: "23505" });
  });

  it("[C-504] la liste commune refuse un motif autre que rebond ou plainte", async () => {
    await expect(commune({ motif: "desabonnement" })).rejects.toMatchObject({ code: "23514" });
    await expect(commune({ empreinte: "contact@exemple.fr" })).rejects.toMatchObject({ code: "23514" });
    expect((await commune({ motif: "rebond", source: "retour_rebond" })).rows[0]).toMatchObject({ motif: "rebond", ajoute_par: "agent-essai" });
    // Qui a ajouté l'adresse est toujours connu : un auteur vide est refusé.
    await expect(commune({ auteur: "  " })).rejects.toMatchObject({ code: "23514" });
  });

  it("[C-456] une entrée à trancher s'ouvre avec son motif et ne se ferme qu'avec une décision et son auteur", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const ligne = await inserer(A, "a_trancher", { organisation_id: A, source: "crm", motif: "email_change", donnees_comparaison: JSON.stringify({ champs: ["email"] }) });
    expect(ligne).toMatchObject({ etat: "ouvert", motif: "email_change", decision: null, tranche_par: null });
    await expect(inserer(A, "a_trancher", { source: "crm", motif: "inconnu" })).rejects.toMatchObject({ code: "22P02" });
    const fermer = (set: string) => ecrire(app, A, (c) => c.query(`UPDATE a_trancher SET ${set} WHERE id = $1`, [ligne["id"]]));
    await expect(fermer("etat = 'tranche'")).rejects.toMatchObject({ code: "23514" });
    await expect(fermer("etat = 'tranche', decision = 'fusionner'")).rejects.toMatchObject({ code: "23514" });
    await expect(fermer("etat = 'tranche', decision = ' ', tranche_par = 'agent-essai'")).rejects.toMatchObject({ code: "23514" });
    expect((await fermer("etat = 'tranche', decision = 'fusionner', tranche_par = 'agent-essai'")).rowCount).toBe(1);
  });

  it("[C-633] une adresse de la liste de la plateforme est lisible par tous les clients ; console_app n'y écrit pas", async () => {
    const A = randomUUID();
    const B = randomUUID();
    const adresse = empreinte(`${randomUUID()}@exemple.fr`);
    await commune({ empreinte: adresse });
    for (const client of [A, B]) {
      expect((await ecrire(app, client, (c) => c.query("SELECT count(*)::int AS n FROM exclusions_plateforme WHERE empreinte_email = $1", [adresse]))).rows[0]?.n).toBe(1);
      await expect(ecrire(app, client, (c) => c.query("INSERT INTO exclusions_plateforme (empreinte_email, motif, source, ajoute_par) VALUES ($1, 'rebond', 'retour_rebond', 'x')", [empreinte(`${randomUUID()}@exemple.fr`)]))).rejects.toMatchObject({ code: "42501" });
      await expect(ecrire(app, client, (c) => c.query("DELETE FROM exclusions_plateforme WHERE empreinte_email = $1", [adresse]))).rejects.toMatchObject({ code: "42501" });
    }
    await expect(equipe.query("DELETE FROM exclusions_plateforme WHERE empreinte_email = $1", [adresse])).rejects.toMatchObject({ code: "42501" });
  });

  it("[C-633] @isolation une exclusion de portée client de A ne s'applique pas à B", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await Promise.all([creerOrg(A), creerOrg(B)]);
    const pris = empreinte(`${randomUUID()}@exemple.fr`);
    await exclusion(A, { empreinte_email: pris });
    expect((await ecrire(app, B, (c) => c.query("SELECT count(*)::int AS n FROM exclusions WHERE empreinte_email = $1", [pris]))).rows[0]?.n).toBe(0);
    // B peut exclure la même adresse : l'unicité est par client.
    await expect(exclusion(B, { empreinte_email: pris })).resolves.toMatchObject({ portee: "client" });
    // La portée plateforme ne se pose pas dans la table des clients (elle n'a pas de ligne sans client).
    await expect(exclusion(A, { portee: "plateforme" })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-119] @isolation console_app du client A ne lit ni la boîte d'envoi, ni les faits, ni la file à trancher, ni les exclusions de B", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await Promise.all([creerOrg(A), creerOrg(B)]);
    const [envoiB, faitB] = [await envoi(B), await fait(B)];
    await inserer(B, "a_trancher", { source: "hub", motif: "ressaisie_manuelle" });
    await exclusion(B);
    await envoi(A);
    await ecrire(app, A, async (c) => {
      for (const t of ["boite_envoi", "faits_recus", "a_trancher", "exclusions"]) {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [B])).rows[0]?.n, t).toBe(0);
      }
    });
    await expect(ecrire(app, A, (c) => c.query("DELETE FROM boite_envoi WHERE tenant_id = $1", [B]))).rejects.toMatchObject({ code: "42501" });
    expect((await ecrire(app, A, (c) => c.query("UPDATE boite_envoi SET etat = 'echec' WHERE id = $1", [envoiB["id"]]))).rowCount).toBe(0);
    // Écrire au nom de B (WITH CHECK) est refusé ; l'équipe, elle, lit tout en lecture seule.
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO faits_recus (id, tenant_id, source, event_id, type, sequence, sujet) VALUES ($1, $2, 'hub', $3, 't', 1, 's')", [randomUUID(), B, randomUUID()]))).rejects.toMatchObject({ code: "42501" });
    expect(await avecEquipe(equipe, async (c) => (await c.query("SELECT tenant_id FROM faits_recus WHERE id = $1", [faitB["id"]])).rows[0]?.tenant_id)).toBe(B);
    await expect(equipe.query("UPDATE boite_envoi SET etat = 'echec'")).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-119] toutes les migrations appliquées, les invariants C5 ne trouvent aucun écart", async () => {
    const ecarts = (await controlerInvariants(requete, "console", OPTIONS)).filter((e) => !/(^|\.)essai_/.test(e.objet) && !e.objet.startsWith("partman."));
    expect(ecarts).toEqual([]);
    const { rows } = await migration.query("SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY 1", [["boite_envoi", "faits_recus", "liens_crm", "a_trancher", "exclusions", "exclusions_plateforme", "reglage_global_fin_de_contrat", "conditions_par_defaut", "alertes_plateforme"]]);
    expect(rows).toHaveLength(9);
    expect(EXCEPTIONS_UNICITE).toEqual([{ table: "instances", index: "instances_id_unique", raison: "ADR 0111" }]);
  });
});

describe("lignes de la plateforme, avec le socle", { timeout: 30_000 }, () => {
  const PLATEFORME = "00000000-0000-0000-0000-000000000001";
  const parEquipe = (table: string, valeurs: Record<string, unknown>) => {
    const v = { id: randomUUID(), ...valeurs };
    const cles = Object.keys(v);
    return equipeRejouee(`INSERT INTO ${table} (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, Object.values(v));
  };
  const lire = (A: string, table: string) => ecrire(app, A, async (c) => (await c.query(`SELECT tenant_id FROM ${table}`)).rows.map((r) => r.tenant_id as string));

  it("[C-715] le réglage global refuse un délai inférieur à 2 mois, et sa première ligne vaut 24 sous la plateforme", async () => {
    await expect(parEquipe("reglage_global_fin_de_contrat", { tenant_id: PLATEFORME, delai_proposition_suppression_mois: 1, auteur: "agent-essai" })).rejects.toMatchObject({ code: "23514" });
    const { rows } = await equipe.query("SELECT delai_proposition_suppression_mois AS d FROM reglage_global_fin_de_contrat WHERE tenant_id = $1 ORDER BY change_le, id LIMIT 1", [PLATEFORME]);
    expect(rows[0]?.d).toBe(24);
    await expect(parEquipe("reglage_global_fin_de_contrat", { tenant_id: PLATEFORME, delai_proposition_suppression_mois: 36, auteur: "agent-essai" })).resolves.toMatchObject({ rowCount: 1 });
  });

  it("[C-715] @isolation console_app n'écrit pas dans reglage_global_fin_de_contrat et le portail n'y a aucun droit", async () => {
    const A = randomUUID();
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO reglage_global_fin_de_contrat (id, tenant_id, delai_proposition_suppression_mois, auteur) VALUES ($1, $2, 12, 'x')", [randomUUID(), A]))).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE reglage_global_fin_de_contrat SET delai_proposition_suppression_mois = 2"))).rejects.toMatchObject({ code: "42501" });
    await expect(equipe.query("UPDATE reglage_global_fin_de_contrat SET delai_proposition_suppression_mois = 2")).rejects.toMatchObject({ code: "42501" });
    const { rows } = await migration.query(`SELECT DISTINCT a.grantee::regrole::text AS r FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.reglage_global_fin_de_contrat'::regclass AND a.grantee <> c.relowner`);
    expect(rows.map((r) => r.r).sort()).toEqual(["console_app", "console_equipe"]);
  });

  it("[C-715] @isolation un client ne lit que sa ligne et celle de la plateforme, jamais celle d'un autre client", async () => {
    const [A, B] = [randomUUID(), randomUUID()];
    for (const t of [A, B, PLATEFORME]) await parEquipe("reglage_global_fin_de_contrat", { tenant_id: t, delai_proposition_suppression_mois: 30, auteur: "agent-essai" });
    const vus = await lire(A, "reglage_global_fin_de_contrat");
    expect(new Set(vus)).toEqual(new Set([A, PLATEFORME]));
    expect(vus).not.toContain(B);
  });

  it("[A-146] @isolation console_app ne modifie pas conditions_par_defaut ; elle lit celle de la plateforme", async () => {
    const A = randomUUID();
    const ligne = (await parEquipe("conditions_par_defaut", { tenant_id: PLATEFORME, type: "remise", valeur: JSON.stringify({ taux: 5 }), auteur: "agent-essai" })).rows[0];
    expect(ligne).toMatchObject({ source: "defaut", type: "remise" });
    expect(await lire(A, "conditions_par_defaut")).toContain(PLATEFORME);
    await expect(ecrire(app, A, (c) => c.query("UPDATE conditions_par_defaut SET valeur = '{}'::jsonb"))).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO conditions_par_defaut (id, tenant_id, type, valeur) VALUES ($1, $2, 'frais', '{}'::jsonb)", [randomUUID(), A]))).rejects.toMatchObject({ code: "42501" });
    await expect(parEquipe("conditions_par_defaut", { tenant_id: PLATEFORME, type: "frais", valeur: "{}", source: "client", auteur: "agent-essai" })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-130] alertes_plateforme refuse un état hors ouverte, acquittee, close", async () => {
    const alerte = (await parEquipe("alertes_plateforme", { tenant_id: PLATEFORME, type: "sauvegarde", gravite: "critique", regle: "essai" })).rows[0];
    expect(alerte).toMatchObject({ etat: "ouverte", assignee_a: null });
    for (const etat of ["acquittee", "close"]) expect((await equipeRejouee("UPDATE alertes_plateforme SET etat = $2, assignee_a = 'agent-essai' WHERE id = $1 RETURNING etat", [alerte?.id, etat])).rows[0]?.etat).toBe(etat);
    await expect(equipeRejouee("UPDATE alertes_plateforme SET etat = 'resolue' WHERE id = $1", [alerte?.id])).rejects.toMatchObject({ code: "22P02" });
    await expect(ecrire(app, randomUUID(), (c) => c.query("UPDATE alertes_plateforme SET etat = 'close'"))).rejects.toMatchObject({ code: "42501" });
  });
});
