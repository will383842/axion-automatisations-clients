import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, EXCEPTIONS_UNICITE, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Contrats, devis, factures, apporteurs et activation (T2-05). Socle lancé par ops/socle/lancer.sh (job socle-integration).
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

// Les écritures auditées passent par le verrou du journal : une attente trop longue (55P03) est rejouée pour les mises en place.
async function ecrire<T>(...args: Parameters<typeof avecClient<T>>): Promise<T> {
  for (let essai = 1; ; essai++) {
    try {
      return await avecClient(...args);
    } catch (e) {
      if ((e as { code?: string }).code !== "55P03" || essai >= 4) throw e;
    }
  }
}
const inserer = (tenant: string, table: string, valeurs: Record<string, unknown>) => {
  const v = { id: randomUUID(), tenant_id: tenant, ...valeurs };
  const cles = Object.keys(v);
  return ecrire(app, tenant, async (c) => (await c.query(`INSERT INTO ${table} (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${table === "instances" ? "id" : "*"}`, Object.values(v))).rows[0] as Record<string, unknown>, APPELANT);
};
const creerOrg = (id: string) => inserer(id, "organisations", { id, console_client_id: id, raison_sociale: "Boulangerie Rivoire" });
beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

// Le rapport de la CI est un JSON hors du journal : un essai en échec est écrit ici pour être lisible dans le journal du job.
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});


const SHA = "a".repeat(64);
const contrat = (A: string, extra: Record<string, unknown> = {}) =>
  inserer(A, "contrats", { organisation_id: A, type: "sous_traitance_art28", date_signature: "2026-01-15", pdf_ref: `contrats/${A}/art28.pdf`, empreinte_sha256: SHA, auteur: APPELANT.acteur, ...extra });
const instance = (A: string, extra: Record<string, unknown> = {}) =>
  inserer(A, "instances", { organisation_id: A, code_automatisation: "relance-devis", formule: "abonnement", environnement: "production", ...extra });
// TVA toujours ajoutée : arrondi au centime le plus proche, moitié vers le haut, comme la règle de la base (calcul exact en entiers longs).
const tva = (ht: number, taux: number) => Number((BigInt(ht) * BigInt(taux) + 5000n) / 10000n);
const montants = (ht: number, taux = 2000) => ({ montant_ht_centimes: ht, taux_tva_points_de_base: taux, montant_tva_centimes: tva(ht, taux), montant_ttc_centimes: ht + tva(ht, taux) });
// Une facture d'abonnement ou de complément se rattache à une instance (clé d'unicité) : une instance en pause par client, sauf si l'essai en nomme une.
const instanceDeFacture = new Map<string, Promise<string>>();
const uneInstance = (A: string) => {
  if (!instanceDeFacture.has(A)) instanceDeFacture.set(A, instance(A, { etat: "pause" }).then((i) => i["id"] as string));
  return instanceDeFacture.get(A) as Promise<string>;
};
const facture = async (A: string, extra: Record<string, unknown> = {}) => {
  const nature = (extra["nature"] as string | undefined) ?? "abonnement";
  const rattachee = nature === "abonnement" || nature === "complement_prorata";
  const instance_id = "instance_id" in extra || !rattachee ? undefined : await uneInstance(A);
  return inserer(A, "factures", { organisation_id: A, numero: `AXI-FACT-${randomUUID()}`, hub_id: randomUUID(), nature: "abonnement", plan: "essentiel", periode_debut: "2026-02-01", periode_fin: "2026-02-28", ...montants(10000), statut: "emise", pdf_ref: "factures/a.pdf", empreinte_sha256: SHA, auteur: APPELANT.acteur, ...(instance_id ? { instance_id } : {}), ...extra });
};
const avoir = (A: string, origine: unknown, extra: Record<string, unknown> = {}) => facture(A, { nature: "avoir", facture_origine_id: origine, ...extra });
const majFacture = (A: string, id: unknown, set: string, appelant: typeof APPELANT | null = APPELANT) => ecrire(app, A, (c) => c.query(`UPDATE factures SET ${set} WHERE id = $1`, [id]), appelant ?? undefined);
// Changement de statut au nom de l'appelant : le statut et son auteur (statut_par) changent ensemble.
const changerStatut = (A: string, id: unknown, statut: string, appelant: typeof APPELANT | null = APPELANT) => majFacture(A, id, `statut = '${statut}', statut_par = '${APPELANT.acteur}'`, appelant);
const majDevis = (A: string, id: unknown, set: string, appelant: typeof APPELANT | null = APPELANT) => ecrire(app, A, (c) => c.query(`UPDATE devis SET ${set} WHERE id = $1`, [id]), appelant ?? undefined);
const devisBrouillon = (A: string, extra: Record<string, unknown> = {}) => inserer(A, "devis", { organisation_id: A, numero_hub: `DEV-${randomUUID()}`, pdf_ref: "devis/a.pdf", duree_validite_jours: 30, ...extra });
const ANNULATION = `statut = 'annule', motif_annulation = 'erreur de saisie', annule_le = now(), annule_par = '${APPELANT.acteur}'`;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);
// Deux connexions en parallèle sur la même ligne : la première écrit et garde son verrou, la seconde démarre alors et attend, la première valide, la seconde reprend sur la version validée.
async function course(A: string, premiere: (c: pg.PoolClient) => Promise<unknown>, seconde: (c: pg.PoolClient) => Promise<unknown>): Promise<[string | undefined, string | undefined]> {
  let ecrit!: () => void;
  const apres = new Promise<void>((r) => (ecrit = r));
  const t1 = code(ecrire(app, A, async (c) => { try { await premiere(c); } finally { ecrit(); } await new Promise((r) => setTimeout(r, 1000)); }, APPELANT));
  await apres;
  const t2 = code(ecrire(app, A, seconde, APPELANT));
  return [await t1, await t2];
}

describe("contrats, devis, factures et activation, avec le socle", { timeout: 30_000 }, () => {
  it("[C-030] une instance insérée directement à l'état active sans contrat est refusée ; avec le contrat signé elle passe", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await expect(instance(A, { etat: "active" })).rejects.toMatchObject({ code: "P0001", message: "regle_metier", detail: "sous_traitance_absente" });
    await expect(instance(A)).rejects.toMatchObject({ detail: "sous_traitance_absente" }); // l'état par défaut est active
    expect(await code(instance(A, { etat: "pause" }))).toBe("ok");
    await contrat(A);
    expect(await code(instance(A, { etat: "active" }))).toBe("ok");
  });

  it("[C-030] l'activation d'une instance est refusée tant que le contrat de sous-traitance du client n'est pas signé (UPDATE direct)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = (await instance(A, { etat: "pause" }))["id"] as string;
    await expect(ecrire(app, A, (c) => c.query("UPDATE instances SET etat = 'active' WHERE id = $1", [id]), APPELANT)).rejects.toMatchObject({ detail: "sous_traitance_absente" });
    await contrat(A, { type: "contrat_service" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE instances SET etat = 'active' WHERE id = $1", [id]), APPELANT)).rejects.toMatchObject({ detail: "sous_traitance_absente" });
    await contrat(A, { date_signature: "2999-01-01" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE instances SET etat = 'active' WHERE id = $1", [id]), APPELANT)).rejects.toMatchObject({ detail: "sous_traitance_absente" });
    await contrat(A);
    expect((await ecrire(app, A, (c) => c.query("UPDATE instances SET etat = 'active' WHERE id = $1", [id]), APPELANT)).rowCount).toBe(1);
  });

  it("[C-030] @isolation un contrat de sous-traitance d'un autre client ne permet pas l'activation", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    await contrat(B);
    await expect(instance(A, { etat: "active" })).rejects.toMatchObject({ detail: "sous_traitance_absente" });
    // Contrat du client A rangé sous une autre organisation : refusé par la clé étrangère composée.
    await expect(contrat(A, { organisation_id: B })).rejects.toMatchObject({ code: "23503" });
  });

  it("[A-155] le contrat de sous-traitance est rangé avec son empreinte et ne se modifie ni ne se supprime", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const c = await contrat(A);
    expect(c).toMatchObject({ type: "sous_traitance_art28", empreinte_sha256: SHA });
    await expect(ecrire(app, A, (x) => x.query("UPDATE contrats SET date_signature = '2020-01-01' WHERE id = $1", [c["id"]]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (x) => x.query("DELETE FROM contrats WHERE id = $1", [c["id"]]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(contrat(A, { empreinte_sha256: "pas-une-empreinte" })).rejects.toMatchObject({ code: "23514" });
    await expect(contrat(A, { pdf_ref: "JVBERi0xLjQK".repeat(40) })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-148] un contrat refuse un type hors énumération", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await expect(contrat(A, { type: "contrat_inconnu" })).rejects.toMatchObject({ code: "22P02" });
  });

  it("[A-154] un devis refuse un statut hors énumération ; un numéro du Hub n'existe qu'une fois par client", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const d = (extra: Record<string, unknown> = {}) => inserer(A, "devis", { organisation_id: A, numero_hub: "DEV-0001", pdf_ref: "devis/a.pdf", duree_validite_jours: 30, ...extra });
    await expect(d({ statut: "perdu" })).rejects.toMatchObject({ code: "22P02" });
    await d();
    await expect(d()).rejects.toMatchObject({ code: "23505" });
    await expect(d({ numero_hub: "DEV-0002", statut: "annule" })).rejects.toMatchObject({ code: "23514" }); // un devis annulé garde motif, date et auteur de l'annulation (la copie complète passe, voir les essais de statuts)
    const b = await d({ numero_hub: "DEV-0003" });
    await expect(majDevis(A, b["id"], `statut = 'annule', annule_par = '${APPELANT.acteur}'`)).rejects.toMatchObject({ code: "23514" }); // annulé sans motif ni date
  });

  it("[A-133] @argent deux factures d'abonnement pour la même période sont refusées ; un avoir passe", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await facture(A);
    await expect(facture(A)).rejects.toMatchObject({ code: "23505" });
    const origine = (await facture(A, { periode_debut: "2026-09-01", periode_fin: "2026-09-30" }))["id"];
    expect(await code(avoir(A, origine))).toBe("ok");
    expect(await code(facture(A, { periode_debut: "2026-03-01", periode_fin: "2026-03-31" }))).toBe("ok");
    expect(await code(facture(A, { plan: "avance" }))).toBe("ok");
  });

  it("[A-133] @argent une seconde facture de mise en place pour la même automatisation est refusée", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const mep = (extra: Record<string, unknown> = {}) => facture(A, { nature: "mise_en_place", plan: null, code_automatisation: "relance-devis", ...extra });
    await mep();
    await expect(mep()).rejects.toMatchObject({ code: "23505" });
    expect(await code(mep({ code_automatisation: "suivi-chantier" }))).toBe("ok");
  });

  it("[A-133] @argent la console ne modifie jamais le montant, le numéro ni le PDF d'une facture reçue ; le statut seul change", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const f = await facture(A);
    for (const colonne of ["montant_ht_centimes = 1", "numero = 'AXI-FACT-X'", "pdf_ref = 'x.pdf'", "nature = 'avoir'", "taux_tva_points_de_base = 1", "montant_tva_centimes = 1", "montant_ttc_centimes = 1", "facture_origine_id = gen_random_uuid()"]) {
      await expect(ecrire(app, A, (c) => c.query(`UPDATE factures SET ${colonne} WHERE id = $1`, [f["id"]]), APPELANT), colonne).rejects.toMatchObject({ code: "42501" });
    }
    await expect(majFacture(A, f["id"], "auteur = 'agent-essai'")).rejects.toMatchObject({ code: "42501" }); // l'auteur est figé à la création
    expect((await changerStatut(A, f["id"], "payee")).rowCount).toBe(1);
  });

  it("[A-163] @isolation @argent le même numéro de facture chez deux clients passe, chez le même client est refusé, et le client A ne reçoit aucune erreur 23505 révélant une facture de B", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const numero = `AXI-FACT-${randomUUID()}`;
    await facture(B, { numero });
    expect(await code(facture(A, { numero }))).toBe("ok");
    await expect(facture(A, { numero, hub_id: randomUUID(), periode_debut: "2026-05-01", periode_fin: "2026-05-31" })).rejects.toMatchObject({ code: "23505" });
  });

  it("[A-147] la table des apporteurs ne reçoit aucune écriture de console_app (taux et commissions viennent de la synchronisation)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    for (const sql of ["INSERT INTO apporteurs_clients (tenant_id, id, organisation_id, apporteur_axion_ia_id, taux_points_de_base) VALUES ($1, gen_random_uuid(), $1, 'app-1', 500)", "UPDATE apporteurs_clients SET taux_points_de_base = 9000", "DELETE FROM apporteurs_clients"]) {
      await expect(ecrire(app, A, (c) => c.query(sql, sql.includes("$1") ? [A] : []), APPELANT), sql).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("[A-133] @argent contrat, facture et devis annulé n'existent que sous un appelant : écriture sans appelant ou auteur falsifié refusés (42501)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const brut = (table: string, valeurs: Record<string, unknown>, appelant?: typeof APPELANT) => {
      const v = { id: randomUUID(), tenant_id: A, ...valeurs };
      return ecrire(app, A, (c) => c.query(`INSERT INTO ${table} (${Object.keys(v).join(", ")}) VALUES (${Object.keys(v).map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(v)), appelant);
    };
    const contratBrut = { organisation_id: A, type: "contrat_service", date_signature: "2026-01-15", pdf_ref: "contrats/a.pdf", empreinte_sha256: SHA };
    await expect(brut("contrats", { ...contratBrut, auteur: "agent-essai" })).rejects.toMatchObject({ code: "42501" }); // aucun appelant
    await expect(brut("contrats", { ...contratBrut, auteur: "systeme" }, APPELANT)).rejects.toMatchObject({ code: "42501" }); // auteur différent de l'appelant
    await expect(brut("contrats", { ...contratBrut, auteur: "  " }, APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(brut("contrats", contratBrut, APPELANT)).rejects.toMatchObject({ code: "42501" }); // auteur absent
    const f = await facture(A);
    await expect(facture(A, { auteur: "systeme" })).rejects.toMatchObject({ code: "42501" });
    await expect(facture(A, { statut_par: "agent-essai", periode_debut: "2026-03-01", periode_fin: "2026-03-28" })).rejects.toMatchObject({ code: "42501" }); // née sans auteur de statut
    await expect(changerStatut(A, f["id"], "impayee", null)).rejects.toMatchObject({ code: "42501" }); // aucun appelant
    await expect(majFacture(A, f["id"], "statut = 'impayee', statut_par = 'systeme'")).rejects.toMatchObject({ code: "42501" });
    await expect(majFacture(A, f["id"], "statut = 'impayee'")).rejects.toMatchObject({ code: "42501" }); // statut sans auteur de statut
    await expect(majFacture(A, f["id"], "statut = 'impayee', auteur = 'agent-essai', statut_par = 'agent-essai'")).rejects.toMatchObject({ code: "42501" }); // auteur figé
    expect((await changerStatut(A, f["id"], "impayee")).rowCount).toBe(1);
    expect((await ecrire(app, A, (c) => c.query("SELECT auteur, statut_par FROM factures WHERE id = $1", [f["id"]]))).rows[0]).toEqual({ auteur: "agent-essai", statut_par: "agent-essai" });
    const d = await devisBrouillon(A);
    // Un devis ne s'écrit jamais sans appelant : ni l'insertion ni un passage à « accepté ».
    const sansAppelant = { organisation_id: A, numero_hub: `DEV-${randomUUID()}`, pdf_ref: "devis/a.pdf", duree_validite_jours: 30 };
    await expect(brut("devis", sansAppelant)).rejects.toMatchObject({ code: "42501" });
    const e = await devisBrouillon(A);
    expect((await majDevis(A, e["id"], "statut = 'envoye', date_envoi = now()")).rowCount).toBe(1);
    await expect(majDevis(A, e["id"], "statut = 'accepte'", null)).rejects.toMatchObject({ code: "42501" });
    expect((await majDevis(A, e["id"], "statut = 'accepte'")).rowCount).toBe(1);
    await expect(majDevis(A, d["id"], ANNULATION, null)).rejects.toMatchObject({ code: "42501" });
    await expect(majDevis(A, d["id"], "statut = 'annule', motif_annulation = 'erreur', annule_le = now(), annule_par = 'quelquun-d-autre'")).rejects.toMatchObject({ code: "42501" });
    expect((await majDevis(A, d["id"], ANNULATION)).rowCount).toBe(1);
  });

  it("[A-133] @argent une facture annulée libère sa période et son automatisation : facture A, annulation, avoir, facture B du même plan et de la même période passent", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const a = await facture(A);
    await expect(facture(A)).rejects.toMatchObject({ code: "23505" }); // tant qu'elle n'est pas annulée, la période est prise
    expect(await code(avoir(A, a["id"]))).toBe("ok"); // l'avoir précède l'annulation
    await changerStatut(A, a["id"], "annulee");
    expect(await code(facture(A))).toBe("ok"); // la facture rectifiée
    await expect(facture(A)).rejects.toMatchObject({ code: "23505" }); // la seconde active, elle, bloque
    const mep = (extra: Record<string, unknown> = {}) => facture(A, { nature: "mise_en_place", plan: null, code_automatisation: "relance-devis", ...extra });
    const m = await mep();
    await avoir(A, m["id"]);
    await changerStatut(A, m["id"], "annulee");
    expect(await code(mep())).toBe("ok");
    await expect(mep()).rejects.toMatchObject({ code: "23505" });
  });

  it("[A-133] @argent le Hub fait foi : une copie arrive dans l'état du Hub (émise, impayée, payée ou annulée) ; les quatre statuts se changent librement, avec l'auteur du changement", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const periode = (n: number) => ({ periode_debut: `2026-0${n}-01`, periode_fin: `2026-0${n}-28` });
    // Une facture peut être reçue déjà payée, impayée ou annulée : la base ne refuse pas la copie d'une vraie facture.
    for (const [i, statut] of ["emise", "impayee", "payee", "annulee"].entries()) expect(await code(facture(A, { statut, ...periode(i + 1) })), `copie ${statut}`).toBe("ok");
    // paiement.rejete : payée vers impayée ; plus aucun statut n'est définitif ; annulée sans avoir.
    const f = await facture(A, periode(5));
    for (const statut of ["payee", "impayee", "payee", "payee", "annulee", "emise", "impayee", "annulee", "payee"]) expect((await changerStatut(A, f["id"], statut)).rowCount, `vers ${statut}`).toBe(1);
    const g = await facture(A, periode(6));
    expect((await changerStatut(A, g["id"], "annulee")).rowCount).toBe(1); // annulée sans avoir
    // Rien n'est libre sans appelant nommé ni sans l'auteur du changement.
    await expect(changerStatut(A, f["id"], "impayee", null)).rejects.toMatchObject({ code: "42501" });
    await expect(majFacture(A, f["id"], "statut = 'impayee', statut_par = 'systeme'")).rejects.toMatchObject({ code: "42501" });
    const neuve = await facture(A, periode(7));
    await expect(majFacture(A, neuve["id"], "statut = 'impayee'")).rejects.toMatchObject({ code: "42501" }); // statut sans auteur du changement
    expect((await ecrire(app, A, (c) => c.query("SELECT statut, statut_par FROM factures WHERE id = $1", [f["id"]]))).rows[0]).toEqual({ statut: "payee", statut_par: "agent-essai" });
  });

  it("[A-133] @argent chaque changement de statut d'une facture est inscrit au journal d'audit, avec l'ancien et le nouveau statut", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const f = await facture(A);
    await changerStatut(A, f["id"], "payee");
    await changerStatut(A, f["id"], "impayee");
    const { rows } = await migration.query("SELECT action::text AS action, ancienne->>'statut' AS avant, nouvelle->>'statut' AS apres, acteur FROM journal_audit WHERE tenant_id = $1 AND entite = 'factures' AND coalesce(nouvelle->>'id', ancienne->>'id') = $2 ORDER BY id", [A, f["id"]]);
    expect(rows.map((r) => [r["avant"], r["apres"], r["acteur"]])).toEqual([[null, "emise", "agent-essai"], ["emise", "payee", "agent-essai"], ["payee", "impayee", "agent-essai"]]);
  });

  it("[A-133] @argent le déclencheur fige les colonnes reçues (montants, taux, numéro, identifiant du Hub, PDF, empreinte, nature, période) même si le droit de colonne était élargi", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const f = await facture(A);
    // Transaction du propriétaire avec une politique d'essai (annulée en fin d'essai) : aucun droit de colonne n'est touché pour les autres essais. Le changement de statut, permis, accompagne chaque colonne : seul le déclencheur peut refuser.
    const cx = await migration.connect();
    try {
      await cx.query("BEGIN");
      await cx.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.acteur', 'agent-essai', true)", [A]);
      await cx.query("CREATE POLICY essai_figees ON public.factures FOR ALL TO console_proprietaire USING (true) WITH CHECK (true)");
      for (const colonne of ["montant_ht_centimes = 1", "montant_tva_centimes = 1", "montant_ttc_centimes = 1", "taux_tva_points_de_base = 1000", "numero = 'AXI-FACT-X'", "hub_id = 'hub-x'", "pdf_ref = 'x.pdf'", `empreinte_sha256 = '${"b".repeat(64)}'`, "nature = 'mise_en_place'", "periode_debut = '2026-02-02'", "periode_fin = '2026-03-01'", "auteur = 'autre'"]) {
        await cx.query("SAVEPOINT s");
        await expect(cx.query(`UPDATE public.factures SET statut = 'impayee', statut_par = 'agent-essai', ${colonne} WHERE id = $1`, [f["id"]]), colonne).rejects.toMatchObject({ code: "42501" });
        await cx.query("ROLLBACK TO SAVEPOINT s");
      }
      expect((await cx.query("UPDATE public.factures SET statut = 'payee', statut_par = 'agent-essai' WHERE id = $1", [f["id"]])).rowCount).toBe(1); // le statut, lui, passe
    } finally {
      await cx.query("ROLLBACK").catch(() => undefined);
      cx.release();
    }
  });

  it("[A-133] @argent le montant d'une facture reçue ne se modifie pas (42501) et reste celui du Hub", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const f = await facture(A);
    await expect(majFacture(A, f["id"], "montant_ht_centimes = 1")).rejects.toMatchObject({ code: "42501" });
    expect((await ecrire(app, A, (c) => c.query("SELECT montant_ht_centimes::int AS ht FROM factures WHERE id = $1", [f["id"]]))).rows[0]).toEqual({ ht: 10000 });
  });

  it("[A-133] @argent deux connexions concurrentes sur la même facture : la seconde attend, puis écrit sur la version validée (payée vers annulée, sans avoir) ; le dernier mot est celui du Hub, et un montant concurrent est refusé par le droit de colonne (42501)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const f = await facture(A);
    const [premiere, seconde] = await course(A, (c) => c.query("UPDATE factures SET statut = 'payee', statut_par = 'agent-essai' WHERE id = $1", [f["id"]]), (c) => c.query("UPDATE factures SET statut = 'annulee', statut_par = 'agent-essai' WHERE id = $1", [f["id"]]));
    expect([premiere, seconde]).toEqual(["ok", "ok"]);
    expect((await ecrire(app, A, (c) => c.query("SELECT statut FROM factures WHERE id = $1", [f["id"]]))).rows[0]).toEqual({ statut: "annulee" });
    // Le droit de colonne (42501) refuse un montant concurrent pour `console_app`. Le déclencheur, lui, est prouvé dans l'essai du propriétaire (politique d'essai ouverte) « le déclencheur fige les colonnes reçues » : cette course ne le prouve pas.
    const [p2, s2] = await course(A, (c) => c.query("UPDATE factures SET statut = 'impayee', statut_par = 'agent-essai' WHERE id = $1", [f["id"]]), (c) => c.query("UPDATE factures SET montant_ht_centimes = 1 WHERE id = $1", [f["id"]]));
    expect([p2, s2]).toEqual(["ok", "42501"]);
    expect((await ecrire(app, A, (c) => c.query("SELECT montant_ht_centimes::int AS ht FROM factures WHERE id = $1", [f["id"]]))).rows[0]).toEqual({ ht: 10000 });
  });

  it("[C-030] course : une double révocation concurrente d'un contrat est refusée (42501) ; la première date reste", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const c = await contrat(A);
    const revoquer = (date: string) => (x: pg.PoolClient) => x.query(`UPDATE contrats SET revoque_le = '${date}', revoque_par = 'agent-essai' WHERE id = $1`, [c["id"]]);
    const [premiere, seconde] = await course(A, revoquer("2026-03-01T10:00:00Z"), revoquer("2026-04-01T10:00:00Z"));
    expect(premiere).toBe("ok");
    expect(seconde).toBe("42501");
    expect((await ecrire(app, A, (x) => x.query("SELECT revoque_le::text FROM contrats WHERE id = $1", [c["id"]]))).rows[0]?.["revoque_le"]).toMatch(/^2026-03-01/);
  });

  it("[A-154] course : un devis annulé par une écriture concurrente n'est pas remis en brouillon (42501)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const d = await devisBrouillon(A);
    const [premiere, seconde] = await course(
      A,
      (c) => c.query(`UPDATE devis SET ${ANNULATION} WHERE id = $1`, [d["id"]]),
      (c) => c.query("UPDATE devis SET statut = 'brouillon', motif_annulation = NULL, annule_le = NULL, annule_par = NULL WHERE id = $1", [d["id"]]),
    );
    expect(premiere).toBe("ok");
    expect(seconde).toBe("42501");
    expect((await ecrire(app, A, (c) => c.query("SELECT statut FROM devis WHERE id = $1", [d["id"]]))).rows[0]).toEqual({ statut: "annule" });
  });

  it("[A-154] @argent le Hub fait foi : un devis arrive dans l'état du Hub ; brouillon, envoyé, accepté, refusé et expiré se changent librement (signature retirée comprise)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const DATE = "2026-01-02T10:00:00Z";
    for (const statut of ["brouillon", "envoye", "accepte", "refuse", "expire"]) expect(await code(devisBrouillon(A, { statut, date_envoi: statut === "brouillon" ? null : DATE })), `copie ${statut}`).toBe("ok");
    await expect(devisBrouillon(A, { statut: "envoye" })).rejects.toMatchObject({ code: "23514" }); // envoyé sans date d'envoi
    const statuts = ["brouillon", "envoye", "accepte", "refuse", "expire"];
    for (const depart of statuts) {
      const d = await devisBrouillon(A, { statut: "envoye", date_envoi: DATE });
      if (depart !== "envoye") expect((await majDevis(A, d["id"], `statut = '${depart}'`)).rowCount, `envoye vers ${depart}`).toBe(1);
      for (const arrivee of statuts) expect((await majDevis(A, d["id"], `statut = '${arrivee}'`)).rowCount, `${depart} vers ${arrivee}`).toBe(1);
    }
    // signature.retiree : un devis accepté revient à « envoyé » (le Hub donne un nouveau lien).
    const s = await devisBrouillon(A, { statut: "accepte", date_envoi: DATE });
    expect((await majDevis(A, s["id"], "statut = 'envoye'")).rowCount).toBe(1);
    // Toujours sous un appelant nommé.
    await expect(majDevis(A, s["id"], "statut = 'accepte'", null)).rejects.toMatchObject({ code: "42501" });
    // L'annulation vient du seul fait devis.annule : elle se pose au nom de l'appelant, de tout statut.
    const e = await devisBrouillon(A, { statut: "accepte", date_envoi: DATE });
    expect((await majDevis(A, e["id"], ANNULATION)).rowCount).toBe(1);
  });

  it("[A-154] @argent un devis annulé l'est pour toujours (statut et colonnes d'annulation figés) ; seule la pose de l'annulation est ouverte", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const d = await devisBrouillon(A);
    expect((await majDevis(A, d["id"], ANNULATION)).rowCount).toBe(1);
    for (const statut of ["brouillon", "envoye", "accepte", "refuse", "expire"]) await expect(majDevis(A, d["id"], `statut = '${statut}'`), `annule vers ${statut}`).rejects.toMatchObject({ code: "42501" });
    await expect(majDevis(A, d["id"], "statut = 'brouillon', motif_annulation = NULL, annule_le = NULL, annule_par = NULL")).rejects.toMatchObject({ code: "42501" });
    await expect(majDevis(A, d["id"], "motif_annulation = NULL")).rejects.toMatchObject({ code: "42501" });
    await expect(majDevis(A, d["id"], "motif_annulation = 'autre motif'")).rejects.toMatchObject({ code: "42501" });
    const lu = (await ecrire(app, A, (c) => c.query("SELECT statut, motif_annulation FROM devis WHERE id = $1", [d["id"]]))).rows[0];
    expect(lu).toEqual({ statut: "annule", motif_annulation: "erreur de saisie" });
  });

  it("[A-154] la date d'envoi d'un devis passe de NULL à une valeur avec le statut envoyé, jamais réécrite ; plan et code d'automatisation ne sont jamais vides", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const d = await devisBrouillon(A);
    await expect(majDevis(A, d["id"], "statut = 'envoye'")).rejects.toMatchObject({ code: "23514" }); // envoyé sans date
    await expect(majDevis(A, d["id"], "date_envoi = now()")).rejects.toMatchObject({ code: "42501" }); // date sans envoi
    await expect(majDevis(A, d["id"], "statut = 'envoye', date_envoi = now()", null)).rejects.toMatchObject({ code: "42501" }); // sans appelant
    expect((await majDevis(A, d["id"], "statut = 'envoye', date_envoi = '2026-01-02T10:00:00Z'")).rowCount).toBe(1);
    await expect(majDevis(A, d["id"], "date_envoi = '2026-01-03T10:00:00Z'")).rejects.toMatchObject({ code: "42501" }); // jamais réécrite
    await expect(majDevis(A, d["id"], "date_envoi = NULL")).rejects.toMatchObject({ code: "42501" });
    await expect(facture(A, { plan: "  " })).rejects.toMatchObject({ code: "23514" });
    await expect(facture(A, { nature: "mise_en_place", plan: null, code_automatisation: " " })).rejects.toMatchObject({ code: "23514" });
    await expect(facture(A, { nature: "complement_prorata", plan: "", periode_debut: "2026-03-01", periode_fin: "2026-03-28" })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-133] @argent la TVA est toujours ajoutée : taux de 1 à 2000 points, total cohérent, TVA positive ; l'arrondi est celui du Hub (un centime d'écart avec le calcul est accepté)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const periode = (n: number) => ({ periode_debut: `2026-${String(n).padStart(2, "0")}-01`, periode_fin: `2026-${String(n).padStart(2, "0")}-28` });
    // Jamais d'exonération (taux 0), jamais au-dessus de 20 % (2001, 5000) : refusés même si la TVA et le total sont cohérents.
    for (const [i, taux] of [0, 2001, 5000, -1].entries()) await expect(facture(A, { ...periode(i + 1), ...montants(10000, taux) }), `taux ${taux}`).rejects.toMatchObject({ code: "23514" });
    await expect(facture(A, { ...periode(6), montant_ttc_centimes: 12001 })).rejects.toMatchObject({ code: "23514" }); // total incohérent
    await expect(facture(A, { ...periode(7), montant_tva_centimes: -2000, montant_ttc_centimes: 8000 })).rejects.toMatchObject({ code: "23514" }); // TVA négative
    for (const colonne of ["taux_tva_points_de_base", "montant_tva_centimes", "montant_ttc_centimes"]) await expect(facture(A, { ...periode(8), [colonne]: null }), colonne).rejects.toMatchObject({ code: "23502" });
    // Le Hub peut arrondir par ligne : la TVA à un centime du calcul d'ensemble est acceptée, dans un sens comme dans l'autre.
    expect(await code(facture(A, { ...periode(9), ...montants(10000, 2000), montant_tva_centimes: 2001, montant_ttc_centimes: 12001 }))).toBe("ok");
    expect(await code(facture(A, { ...periode(10), ...montants(10000, 2000), montant_tva_centimes: 1999, montant_ttc_centimes: 11999 }))).toBe("ok");
    expect(await code(facture(A, { ...periode(11), ...montants(5, 1000), montant_tva_centimes: 0, montant_ttc_centimes: 5 }))).toBe("ok");
    // Les calculs exacts passent toujours ; le plafond de 20 % est inclus.
    expect(await code(facture(A, { ...periode(12), ...montants(15, 1000) }))).toBe("ok");
    expect(await code(facture(A, { ...periode(1), plan: "avance", ...montants(1, 2000) }))).toBe("ok");
    expect(await code(facture(A, { ...periode(2), plan: "avance", ...montants(100, 1) }))).toBe("ok");
    expect([tva(5, 1000), tva(4, 1249), tva(15, 1000), tva(1, 2000)]).toEqual([1, 0, 2, 0]);
  });

  it("[A-133] @argent bornes : un montant au-delà de 2^53 − 1, négatif ou un total qui dépasse est refusé (23514)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const MAX = 9007199254740991;
    await expect(facture(A, { montant_ht_centimes: MAX + 1, taux_tva_points_de_base: 1, montant_tva_centimes: 900719925474, montant_ttc_centimes: MAX + 1 + 900719925474 })).rejects.toMatchObject({ code: "23514" });
    await expect(facture(A, { montant_ht_centimes: MAX, taux_tva_points_de_base: 1, montant_tva_centimes: 900719925474, montant_ttc_centimes: MAX + 900719925474 })).rejects.toMatchObject({ code: "23514" }); // total au-delà
    await expect(facture(A, { montant_ht_centimes: -1, taux_tva_points_de_base: 2000, montant_tva_centimes: 0, montant_ttc_centimes: -1 })).rejects.toMatchObject({ code: "23514" });
    // Près de 2^53 avec le taux maximal : le produit dépasse un entier long, mais le refus reste une contrainte (23514), jamais un dépassement (22003).
    const tvaMax = Number((BigInt(MAX) * 2000n + 5000n) / 10000n);
    await expect(facture(A, { montant_ht_centimes: MAX, taux_tva_points_de_base: 2000, montant_tva_centimes: tvaMax, montant_ttc_centimes: MAX + tvaMax })).rejects.toMatchObject({ code: "23514" });
    await expect(facture(A, { montant_ht_centimes: MAX, taux_tva_points_de_base: 2000, montant_tva_centimes: 1, montant_ttc_centimes: MAX })).rejects.toMatchObject({ code: "23514" });
    // Le plus grand total admis : la borne est incluse.
    const ht = 9007199254740991 - 900719925474;
    expect(await code(facture(A, { montant_ht_centimes: ht, taux_tva_points_de_base: 1, montant_tva_centimes: Math.floor((ht + 5000) / 10000), montant_ttc_centimes: ht + Math.floor((ht + 5000) / 10000) }))).toBe("ok");
  });

  it("[A-133] @argent un avoir renvoie à sa facture d'origine (même client, jamais lui-même, jamais un autre avoir) ; une facture qui n'est pas un avoir n'en a pas", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const fa = await facture(A);
    const fb = await facture(B);
    await expect(facture(A, { nature: "avoir", periode_debut: "2026-04-01", periode_fin: "2026-04-28" })).rejects.toMatchObject({ code: "23514" }); // avoir sans origine
    await expect(facture(A, { facture_origine_id: fa["id"], periode_debut: "2026-05-01", periode_fin: "2026-05-28" })).rejects.toMatchObject({ code: "23514" }); // non-avoir avec origine
    await expect(avoir(A, fb["id"], { periode_debut: "2026-06-01", periode_fin: "2026-06-28" })).rejects.toMatchObject({ code: "23503" }); // origine d'un autre client
    await expect(avoir(A, randomUUID(), { periode_debut: "2026-06-01", periode_fin: "2026-06-28" })).rejects.toMatchObject({ code: "23503" });
    const soi = randomUUID();
    await expect(avoir(A, soi, { id: soi })).rejects.toMatchObject({ code: "23514" }); // avoir de lui-même
    const premier = await avoir(A, fa["id"], { periode_debut: "2026-07-01", periode_fin: "2026-07-28" });
    await expect(avoir(A, premier["id"])).rejects.toMatchObject({ code: "P0001", message: "regle_metier", detail: "origine_avoir" }); // avoir d'un avoir
    expect(await code(avoir(A, fa["id"], { periode_debut: "2026-08-01", periode_fin: "2026-08-28" }))).toBe("ok");
  });

  it("[A-133] @argent deux instances du même plan le même mois ont chacune leur facture d'abonnement ; une instance n'a qu'une facture par plan et par mois ; l'instance est exigée", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const i1 = await instance(A, { etat: "pause" });
    const i2 = await instance(A, { etat: "pause", code_automatisation: "suivi-chantier" });
    expect(await code(facture(A, { instance_id: i1["id"] }))).toBe("ok");
    expect(await code(facture(A, { instance_id: i2["id"] }))).toBe("ok"); // même plan, même mois, autre instance
    await expect(facture(A, { instance_id: i1["id"] })).rejects.toMatchObject({ code: "23505" });
    await expect(facture(A, { instance_id: i2["id"] })).rejects.toMatchObject({ code: "23505" });
    await expect(facture(A, { instance_id: null, periode_debut: "2026-03-01", periode_fin: "2026-03-28" })).rejects.toMatchObject({ code: "23514" });
    await expect(facture(A, { nature: "complement_prorata", plan: null, instance_id: null, periode_debut: "2026-03-01", periode_fin: "2026-03-28" })).rejects.toMatchObject({ code: "23514" });
    // Un complément de prorata, comme une mise en place, ne porte ni plan ni code : son unicité est son identifiant du Hub.
    expect(await code(facture(A, { nature: "complement_prorata", plan: null, instance_id: i1["id"], periode_debut: "2026-03-01", periode_fin: "2026-03-28" }))).toBe("ok");
    expect(await code(facture(A, { nature: "mise_en_place", plan: null, code_automatisation: "relance-devis", instance_id: null }))).toBe("ok");
  });

  it("[C-030] un contrat de sous-traitance révoqué (une fois, par l'appelant) n'autorise plus l'activation ; la révocation ne se défait pas", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const c = await contrat(A);
    const revoquer = (set: string, appelant: typeof APPELANT | null = APPELANT) => ecrire(app, A, (x) => x.query(`UPDATE contrats SET ${set} WHERE id = $1`, [c["id"]]), appelant ?? undefined);
    const i = (await instance(A, { etat: "pause" }))["id"] as string;
    await expect(revoquer("revoque_le = now(), revoque_par = 'agent-essai'", null)).rejects.toMatchObject({ code: "42501" });
    await expect(revoquer("revoque_le = now(), revoque_par = 'quelquun-d-autre'")).rejects.toMatchObject({ code: "42501" });
    await expect(revoquer("revoque_le = now()")).rejects.toMatchObject({ code: "42501" }); // date sans auteur
    await expect(revoquer("date_signature = '2020-01-01'")).rejects.toMatchObject({ code: "42501" });
    expect((await revoquer("revoque_le = now(), revoque_par = 'agent-essai'")).rowCount).toBe(1);
    await expect(revoquer("revoque_le = NULL, revoque_par = NULL")).rejects.toMatchObject({ code: "42501" }); // pas de retour en arrière
    await expect(revoquer("revoque_le = now(), revoque_par = 'agent-essai'")).rejects.toMatchObject({ code: "42501" }); // pas de seconde révocation
    await expect(instance(A, { etat: "active" })).rejects.toMatchObject({ detail: "sous_traitance_absente" });
    await expect(ecrire(app, A, (x) => x.query("UPDATE instances SET etat = 'active' WHERE id = $1", [i]), APPELANT)).rejects.toMatchObject({ detail: "sous_traitance_absente" });
    await contrat(A); // un nouveau contrat signé rouvre l'activation
    expect((await ecrire(app, A, (x) => x.query("UPDATE instances SET etat = 'active' WHERE id = $1", [i]), APPELANT)).rowCount).toBe(1);
  });

  it("[C-030] aucune fonction de déclencheur de T2-05 n'est exécutable par PUBLIC, toutes fixent leur search_path ; l'activation surveille aussi l'organisation", async () => {
    const noms = ["instances_exiger_sous_traitance", "echeances_verifier_facture", "factures_figer_copie", "factures_verifier_origine", "contrats_garder_revocation", "devis_garder_transition"];
    const { rows } = await migration.query(
      `SELECT p.proname, p.proconfig, has_function_privilege('console_equipe', p.oid, 'EXECUTE') AS equipe, has_function_privilege('console_app', p.oid, 'EXECUTE') AS app,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_execute
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY($1) ORDER BY 1`,
      [noms],
    );
    expect(rows.map((r) => r["proname"])).toEqual([...noms].sort());
    for (const r of rows) expect(r, String(r["proname"])).toMatchObject({ proconfig: ["search_path=pg_catalog, pg_temp"], equipe: false, app: false, public_execute: false });
    const defs = (await migration.query("SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1)", [["instances_sous_traitance", "factures_copie_figee", "factures_origine", "contrats_revocation", "devis_transition", "echeances_facture"]])).rows;
    expect(defs.map((d) => d["tgname"]).sort()).toEqual(["contrats_revocation", "devis_transition", "echeances_facture", "factures_copie_figee", "factures_origine", "instances_sous_traitance"]);
    expect(String(defs.find((d) => d["tgname"] === "instances_sous_traitance")?.["def"])).toMatch(/UPDATE OF etat, organisation_id/);
    for (const t of ["factures_copie_figee", "contrats_revocation", "devis_transition"]) expect(String(defs.find((d) => d["tgname"] === t)?.["def"]), t).toMatch(/BEFORE UPDATE ON public\.\w+ FOR EACH ROW/);
    expect(String(defs.find((d) => d["tgname"] === "factures_origine")?.["def"])).toMatch(/BEFORE INSERT ON public\.factures/);
  });

  it("[A-147] @argent apporteurs : SIREN de neuf chiffres ; aucune commission due sans SIREN vérifié actif ; montant borné", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const su = pool(DIRECT, "postgres", 2);
    const ajouter = (extra: Record<string, unknown>) => {
      const v = { tenant_id: A, id: randomUUID(), organisation_id: A, apporteur_axion_ia_id: `app-${randomUUID()}`, taux_points_de_base: 500, lu_le: new Date().toISOString(), ...extra };
      // Le propriétaire est soumis à la politique FORCE : seul le superutilisateur écrit (synchronisation de T2-15 à venir). Le journal exige l'acteur et le client.
      return (async () => {
        const c = await su.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.acteur', 'essai-synchro', true), set_config('app.tenant_id', $1, true)", [A]);
          await c.query(`INSERT INTO apporteurs_clients (${Object.keys(v).join(", ")}) VALUES (${Object.keys(v).map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(v));
          await c.query("COMMIT");
          return "ok";
        } catch (e) {
          await c.query("ROLLBACK").catch(() => undefined);
          return (e as { code?: string }).code;
        } finally {
          c.release();
        }
      })();
    };
    const verifie = { siren: "123456782", siren_actif_verifie_le: "2026-01-02T00:00:00Z" };
    expect(await ajouter({ commissions_dues_centimes: 0 })).toBe("ok");
    expect(await ajouter({ siren: "12345678" })).toBe("23514");
    expect(await ajouter({ siren: "12345678a" })).toBe("23514");
    expect(await ajouter({ commissions_dues_centimes: 100 })).toBe("23514");
    expect(await ajouter({ commissions_dues_centimes: 100, siren: "123456782" })).toBe("23514"); // pas de vérification datée
    expect(await ajouter({ commissions_dues_centimes: 100, siren_actif_verifie_le: "2026-01-02T00:00:00Z" })).toBe("23514");
    expect(await ajouter({ commissions_dues_centimes: 100, ...verifie })).toBe("ok");
    expect(await ajouter({ commissions_dues_centimes: -1, ...verifie })).toBe("23514");
    expect(await ajouter({ commissions_dues_centimes: 9007199254740992, ...verifie })).toBe("23514");
  });

  it("[A-119] @isolation toutes les migrations appliquées, les invariants C5 ne trouvent aucun écart", async () => {
    const ecarts = (await controlerInvariants(requete, "console", OPTIONS)).filter((e) => !/(^|\.)essai_/.test(e.objet) && !e.objet.startsWith("partman."));
    expect(ecarts).toEqual([]);
  });

  it("[A-163] la liste EXCEPTIONS_UNICITE reste vide après la migration de T2-05", () => {
    expect(EXCEPTIONS_UNICITE).toEqual([]);
  });
});
