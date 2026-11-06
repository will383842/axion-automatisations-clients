import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Migration 0019 de durcissement du lot 2 (T2-52a, ADR 0111 et 0114) : un essai par ligne M1 à M14 du plan. Socle lancé par ops/socle/lancer.sh (job socle-integration).
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
const app = pool(PGBOUNCER, "console_app", 40);
const equipe = pool(PGBOUNCER, "console_equipe", 5);
// Superutilisateur du socle de test : seul à écrire hors RLS ce que console_app ne peut plus écrire (même méthode que contrats.int.test.ts).
const su = pool(DIRECT, "postgres", 3);
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };
const unique = () => randomUUID().replaceAll("-", "").slice(0, 8);

// Rejeu sur 55P03 (attente du verrou du journal) et 40P01 (interblocage), comme les autres essais d'intégration.
async function ecrire<T>(...args: Parameters<typeof avecClient<T>>): Promise<T> {
  for (let essai = 1; ; essai++) {
    try {
      return await avecClient(...args);
    } catch (e) {
      if (!["55P03", "40P01"].includes((e as { code?: string }).code ?? "") || essai >= 6) throw e;
    }
  }
}
// Écriture de l'équipe : transaction avec le client (app.tenant_id) et l'acteur du journal, qui sont ceux que pose avecEquipeEcriture.
async function commeEquipe<T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await equipe.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.acteur', $1, true), set_config('app.tenant_id', $2, true), set_config('lock_timeout', '5s', true)", [APPELANT.acteur, tenant]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
// Écriture par la connexion de migration (hors RLS), pour poser des lignes que console_app ne peut plus écrire (id d'instance, SIREN, statut final, auteur trop long).
async function commeProprietaire<T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await su.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.acteur', $1, true), set_config('app.tenant_id', $2, true)", [APPELANT.acteur, tenant]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const creerOrg = (A: string) => ecrire(app, A, (c) => c.query("INSERT INTO organisations (id, tenant_id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Atelier Bertin')", [A]), APPELANT);
// Insertion d'instance sous console_app SANS id (M2) : l'UUID est rendu par RETURNING id.
const creerInstance = (A: string) =>
  ecrire(app, A, async (c) => (await c.query("INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $1, 'relance-devis', 'abonnement', 'test', 'pause') RETURNING id", [A])).rows[0]?.["id"] as string, APPELANT);
const cellule = async (code = `cellule-${unique()}`) => {
  const c = await equipe.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.acteur', $1, true)", [APPELANT.acteur]);
    await c.query("INSERT INTO cellules (code, adresse_interne, mode, capacite, nombre_instances, version_image, etat) VALUES ($1, $2, 'mutualise', 50, 3, '1.0.0', 'active')", [code, `${code.replaceAll("_", "-")}.interne.test`]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return code;
};

beforeAll(async () => {
  try {
    await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  } catch (e) {
    // Le message de drizzle ne porte que la requête : l'erreur PostgreSQL (code, message, détail) est dans `cause`.
    const c = ((e as { cause?: unknown }).cause ?? e) as { code?: string; message?: string; detail?: string; constraint?: string; table?: string };
    writeSync(2, `ECHEC-MIGRATION 0019 : code=${c.code ?? "?"} message=${String(c.message ?? "").slice(0, 300)} detail=${String(c.detail ?? "").slice(0, 200)} contrainte=${c.constraint ?? ""} table=${c.table ?? ""}\n`);
    throw e;
  }
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

describe("migration 0019 : durcissement du lot 2, avec le socle", { timeout: 120_000 }, () => {
  // ---- M1
  it("[A-163] instances_id_unique : deux instances de deux clients ne partagent pas le même id (23505)", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const id = await creerInstance(A);
    const colonnes = "(id, tenant_id, organisation_id, code_automatisation, formule, environnement, etat)";
    await expect(commeProprietaire(B, (c) => c.query(`INSERT INTO instances ${colonnes} VALUES ($1, $2, $2, 'relance-devis', 'abonnement', 'test', 'pause')`, [id, B]))).rejects.toMatchObject({ code: "23505", constraint: "instances_id_unique" });
  });

  it("[A-163] la clé primaire (tenant_id, id) et les clés étrangères composites existent (pg_constraint)", async () => {
    const pk = await equipe.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'public.instances'::regclass AND contype = 'p'");
    expect(pk.rows[0]?.["d"]).toMatch(/PRIMARY KEY \(tenant_id, id\)/);
    const fk = await equipe.query("SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.instances'::regclass AND array_length(conkey, 1) = 2");
    expect(fk.rows[0]?.["n"]).toBeGreaterThan(0);
    const defaut = await equipe.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'instances' AND column_name = 'id'");
    expect(defaut.rows[0]?.["column_default"]).toMatch(/gen_random_uuid/);
  });

  // ---- M2
  it("[A-163] console_app : INSERT avec id refusé (42501), INSERT sans id rend l'UUID par RETURNING id, UPDATE de id refusé (42501)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO instances (id, tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $2, $2, 'relance-devis', 'abonnement', 'test', 'pause')", [randomUUID(), A]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    const id = await creerInstance(A);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await expect(ecrire(app, A, (c) => c.query("UPDATE instances SET id = $2 WHERE id = $1", [id, randomUUID()]), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-163] liste fermée des droits de console_app sur instances : ni id, ni cellule_code, ni DELETE", async () => {
    const { rows } = await equipe.query("SELECT a.attname AS colonne, has_column_privilege('console_app', 'public.instances', a.attname, 'INSERT') AS ins, has_column_privilege('console_app', 'public.instances', a.attname, 'UPDATE') AS maj FROM pg_attribute a WHERE a.attrelid = 'public.instances'::regclass AND a.attnum > 0 AND NOT a.attisdropped");
    const de = (p: string) => rows.filter((r) => r[p === "INSERT" ? "ins" : "maj"] === true).map((r) => r["colonne"] as string);
    expect(await equipe.query("SELECT has_table_privilege('console_app', 'public.instances', 'DELETE') AS d").then((r) => r.rows[0]?.["d"])).toBe(false);
    for (const interdite of ["id", "cellule_code"]) expect(de("INSERT")).not.toContain(interdite);
    for (const interdite of ["id", "tenant_id", "cellule_code"]) expect(de("UPDATE")).not.toContain(interdite);
    expect(de("INSERT")).toContain("tenant_id");
    expect(de("UPDATE")).toContain("etat");
  });

  // ---- M3
  it("[A-163] DELETE d'une instance sous console_app refusé (42501), la ligne existe toujours", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await creerInstance(A);
    await expect(ecrire(app, A, (c) => c.query("DELETE FROM instances WHERE id = $1", [id]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    const { rows } = await ecrire(app, A, (c) => c.query("SELECT id FROM instances WHERE id = $1", [id]), APPELANT);
    expect(rows).toHaveLength(1);
  });

  // ---- M4
  it("[C-017] attribuerCellule direct sous console_app refusé (42501) ; par la fonction de l'équipe : succès, et même erreur pour une cellule inconnue et une instance inconnue", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await creerInstance(A);
    const code = await cellule();
    await expect(ecrire(app, A, (c) => c.query("UPDATE instances SET cellule_code = $2 WHERE id = $1", [id, code]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await commeEquipe(A, (c) => c.query("SELECT public.attribuer_cellule($1, $2)", [id, code]));
    const lu = await ecrire(app, A, (c) => c.query("SELECT cellule_code FROM instances WHERE id = $1", [id]), APPELANT);
    expect(lu.rows[0]?.["cellule_code"]).toBe(code);
    const inconnue = await commeEquipe(A, (c) => c.query("SELECT public.attribuer_cellule($1, $2)", [id, `absente-${unique()}`])).catch((e: unknown) => e as { code: string; message: string });
    const autre = await commeEquipe(A, (c) => c.query("SELECT public.attribuer_cellule($1, $2)", [randomUUID(), code])).catch((e: unknown) => e as { code: string; message: string });
    expect(inconnue).toMatchObject({ code: "P0002" });
    expect(autre).toMatchObject({ code: "P0002", message: (inconnue as { message: string }).message });
    // console_app n'exécute pas la fonction.
    await expect(ecrire(app, A, (c) => c.query("SELECT public.attribuer_cellule($1, $2)", [id, code]), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  // ---- M5
  it("[C-017] cellules : c4_x refusé (23514), c4-x accepté, aucun des deux ne correspond à l'autre", async () => {
    await expect(cellule(`c4_${unique()}`)).rejects.toMatchObject({ code: "23514", constraint: "cellules_code_forme_c4" });
    const bon = await cellule(`c4-${unique()}`);
    expect(bon).toMatch(/^c4-/);
    expect(bon.replace("-", "_")).not.toBe(bon);
  });

  // ---- M6
  it("[T2-20] deux nuits en parallèle = une seule ligne a_trancher ouverte", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const cle = `nuit-${unique()}`;
    const ecrireUne = () => ecrire(app, A, (c) => c.query("INSERT INTO a_trancher (tenant_id, id, organisation_id, source, motif, donnees_comparaison) VALUES ($1, gen_random_uuid(), $1, 'hub', 'incoherence_nuit', jsonb_build_object('cle', $2::text))", [A, cle]), APPELANT);
    const resultats = await Promise.allSettled([ecrireUne(), ecrireUne()]);
    expect(resultats.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refus = resultats.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refus.reason).toMatchObject({ code: "23505", constraint: "a_trancher_incoherence_nuit_ouverte_unique" });
    const { rows } = await ecrire(app, A, (c) => c.query("SELECT count(*)::int AS n FROM a_trancher WHERE donnees_comparaison->>'cle' = $1", [cle]), APPELANT);
    expect(rows[0]?.["n"]).toBe(1);
  });

  // ---- M7
  it("[C-455] deux insertions concurrentes de la même demande du Hub ouverte : la seconde refusée en 23505", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const idDemande = `demande-${unique()}`;
    const ecrireUne = () => ecrire(app, A, (c) => c.query("INSERT INTO a_trancher (tenant_id, id, organisation_id, source, motif, donnees_comparaison) VALUES ($1, gen_random_uuid(), $1, 'hub', 'incoherence_nuit', jsonb_build_object('idDemande', $2::text, 'cle', $3::text))", [A, idDemande, `cle-${unique()}`]), APPELANT);
    const resultats = await Promise.allSettled([ecrireUne(), ecrireUne()]);
    expect(resultats.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((resultats.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "23505", constraint: "a_trancher_demande_hub_ouverte_unique" });
  });

  // ---- M8, M9
  it("[T2-14] EXPLAIN de la lecture des lignes dues : Index Scan sur boite_envoi_dues_idx, aucun Seq Scan", async () => {
    const A = randomUUID();
    await creerOrg(A);
    try {
      // Les lignes ont un prochain essai dans un jour : le balayage des autres essais (dues, tous clients confondus) ne les voit pas.
      await ecrire(app, A, (c) => c.query("INSERT INTO boite_envoi (tenant_id, id, destination, route, methode, corps, cle_anti_doublon, empreinte_corps, etat, prochain_essai) SELECT $1, gen_random_uuid(), 'hub', '/essai', 'POST', '{}'::jsonb, gen_random_uuid(), repeat('a', 64), (CASE WHEN g % 50 = 0 THEN 'a_envoyer' ELSE 'envoye' END)::etat_envoi, now() + interval '1 day' FROM generate_series(1, 5000) g", [A]), APPELANT);
      await su.query("ANALYZE boite_envoi");
      const { rows } = await su.query("EXPLAIN (FORMAT JSON) SELECT id FROM boite_envoi WHERE destination = 'hub' AND etat IN ('a_envoyer', 'en_cours') ORDER BY cree_le LIMIT 100");
      const plan = JSON.stringify(rows[0]);
      expect(plan).toContain("boite_envoi_dues_idx");
      expect(plan).not.toContain("Seq Scan");
    } finally {
      await su.query("DELETE FROM boite_envoi WHERE tenant_id = $1", [A]).catch(() => undefined);
    }
  });

  it("[T2-17b] EXPLAIN des alertes non confirmées sur l'index partiel", async () => {
    const A = randomUUID();
    await creerOrg(A);
    try {
      await ecrire(app, A, (c) => c.query("INSERT INTO alertes_c3 (tenant_id, id, event_id, type, reference, confirmee_le) SELECT $1, gen_random_uuid(), gen_random_uuid(), 'ecart_propose', 'ref-' || g, CASE WHEN g % 100 = 0 THEN NULL ELSE now() END FROM generate_series(1, 5000) g", [A]), APPELANT);
      await su.query("ANALYZE alertes_c3");
      const { rows } = await su.query("EXPLAIN (FORMAT JSON) SELECT id FROM alertes_c3 WHERE tenant_id = $1 AND confirmee_le IS NULL ORDER BY cree_le", [A]);
      expect(JSON.stringify(rows[0])).toContain("alertes_c3_non_confirmees_idx");
    } finally {
      await su.query("DELETE FROM alertes_c3 WHERE tenant_id = $1", [A]).catch(() => undefined);
    }
  });

  // ---- M10
  it("[C-609] après leverGel, le motif de levée se relit sur le gel levé ; levée sans motif refusée (23514) ; aucun DELETE sur gels_litige", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const gel = await ecrire(app, A, async (c) => (await c.query("INSERT INTO gels_litige (tenant_id, id, organisation_id, motif_litige, posee_par) VALUES ($1, gen_random_uuid(), $1, 'litige essai', 'agent-essai') RETURNING id", [A])).rows[0]?.["id"] as string, APPELANT);
    await expect(ecrire(app, A, (c) => c.query("UPDATE gels_litige SET levee_le = now(), leve_par = 'agent-essai' WHERE id = $1", [gel]), APPELANT)).rejects.toMatchObject({ code: "23514", constraint: "gels_litige_levee_avec_motif" });
    await ecrire(app, A, (c) => c.query("UPDATE gels_litige SET levee_le = now(), leve_par = 'agent-essai', motif_levee = 'litige clos' WHERE id = $1", [gel]), APPELANT);
    const { rows } = await ecrire(app, A, (c) => c.query("SELECT motif_levee FROM gels_litige WHERE id = $1", [gel]), APPELANT);
    expect(rows[0]?.["motif_levee"]).toBe("litige clos");
    await expect(ecrire(app, A, (c) => c.query("DELETE FROM gels_litige WHERE id = $1", [gel]), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  // ---- M11
  it("[C-550] lu_le mis à jour pour un apporteur connu, 0 ligne créée pour un inconnu", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await commeProprietaire(A, (c) => c.query("INSERT INTO apporteurs_clients (tenant_id, id, organisation_id, apporteur_axion_ia_id, taux_points_de_base, lu_le) VALUES ($1, gen_random_uuid(), $1, 'app-connu', 500, now() - interval '1 day')", [A]));
    const maj = await ecrire(app, A, (c) => c.query("UPDATE apporteurs_clients SET lu_le = now() WHERE apporteur_axion_ia_id = $1", ["app-connu"]), APPELANT);
    expect(maj.rowCount).toBe(1);
    const inconnu = await ecrire(app, A, (c) => c.query("UPDATE apporteurs_clients SET lu_le = now() WHERE apporteur_axion_ia_id = $1", ["app-inconnu"]), APPELANT);
    expect(inconnu.rowCount).toBe(0);
    const { rows } = await ecrire(app, A, (c) => c.query("SELECT count(*)::int AS n FROM apporteurs_clients", []), APPELANT);
    expect(rows[0]?.["n"]).toBe(1);
  });

  it("[C-550] SIREN de 9 chiffres à clé de Luhn fausse refusé (23514), SIREN valide accepté", async () => {
    const A = randomUUID();
    await creerOrg(A);
    // 732829320 : SIREN fictif à clé de Luhn valide ; 732829321 : même base, clé fausse.
    const poser = (siren: string, id: string) => commeProprietaire(A, (c) => c.query("INSERT INTO apporteurs_clients (tenant_id, id, organisation_id, apporteur_axion_ia_id, taux_points_de_base, lu_le, siren) VALUES ($1, gen_random_uuid(), $1, $2, 500, now(), $3)", [A, id, siren]));
    await expect(poser("732829321", "app-faux")).rejects.toMatchObject({ code: "23514", constraint: "apporteurs_clients_siren_luhn" });
    await poser("732829320", "app-valide");
  });

  // ---- M12
  it("[T2-07] auteur de 201 caractères refusé (23514)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await creerInstance(A);
    // auteur doit valoir app.acteur pour console_app (politique du lot 2) et l'acteur est borné à 128 : la borne de 200 se prouve par l'écriture hors RLS.
    const inserer = (auteur: string) => commeProprietaire(A, (c) => c.query("INSERT INTO executions (tenant_id, id, instance_id, auteur) VALUES ($1, gen_random_uuid(), $2, $3)", [A, id, auteur]));
    await expect(inserer("a".repeat(201))).rejects.toMatchObject({ code: "23514" });
    await inserer("a".repeat(200));
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO alertes (tenant_id, id, organisation_id, type, gravite, regle, assignee_a) VALUES ($1, gen_random_uuid(), $1, 'essai', 'information', 'essai', $2)", [A, "b".repeat(201)]), APPELANT)).rejects.toMatchObject({ code: "23514", constraint: "alertes_assignee_borne" });
  });

  // ---- M13
  it("[T2-07] une proposition acceptee, refusee ou expiree ne change plus de statut (23514)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await commeProprietaire(A, async (c) => (await c.query("INSERT INTO propositions (tenant_id, id, organisation_id, statut, identifiant_hub, nombre_paliers) VALUES ($1, gen_random_uuid(), $1, 'acceptee', $2, 1) RETURNING id", [A, `prop-${unique()}`])).rows[0]?.["id"] as string);
    await expect(commeProprietaire(A, (c) => c.query("UPDATE propositions SET statut = 'refusee' WHERE id = $1", [id]))).rejects.toMatchObject({ code: "23514" });
  });

  // ---- M14
  it("[A-218] deux réservations simultanées du même (quota, seuil, période) : une seule passe", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const reserver = () => ecrire(app, A, (c) => c.query("INSERT INTO reservations_alertes_quota (tenant_id, quota, seuil, periode, reserve_le) VALUES ($1, 'base', 70, '2026-11', now())", [A]), APPELANT);
    const resultats = await Promise.allSettled([reserver(), reserver()]);
    expect(resultats.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((resultats.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "23505" });
    await expect(ecrire(app, A, (c) => c.query("DELETE FROM reservations_alertes_quota", []), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-218] une réservation orpheline de plus de N minutes est reprise par la mesure suivante (horloge injectée)", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    await ecrire(app, A, (c) => c.query("INSERT INTO reservations_alertes_quota (tenant_id, quota, seuil, periode, reserve_le) VALUES ($1, 'fichiers', 100, '2026-11', $2)", [A, "2026-11-06T10:00:00Z"]), APPELANT);
    // Reprise : la ligne réservée avant l'horloge moins N minutes, sans envoi, est remise à NULL puis re-réservée ; le droit d'écriture est limité à reserve_le et envoye_le.
    const maintenant = "2026-11-06T11:00:00Z";
    const reprise = await ecrire(app, A, (c) => c.query("UPDATE reservations_alertes_quota SET reserve_le = $1 WHERE quota = 'fichiers' AND envoye_le IS NULL AND reserve_le < $1::timestamptz - interval '15 minutes'", [maintenant]), APPELANT);
    expect(reprise.rowCount).toBe(1);
    // Isolation : le client B ne voit rien et ne modifie rien chez A.
    const vue = await ecrire(app, B, (c) => c.query("SELECT count(*)::int AS n FROM reservations_alertes_quota", []), APPELANT);
    expect(vue.rows[0]?.["n"]).toBe(0);
    await expect(ecrire(app, A, (c) => c.query("UPDATE reservations_alertes_quota SET quota = 'tous'", []), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });
});
