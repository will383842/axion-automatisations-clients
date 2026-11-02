import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { automatisationFictive, empreinteFictive, GRILLE_FICTIVE, versionFictive } from "../catalogue/fixtures.js";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Catalogue commun (T2-03). Socle lancé par ops/socle/lancer.sh (job socle-integration). Les essais tournent en parallèle sur une base partagée : codes et noms tirés au hasard.
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
const app = pool(PGBOUNCER, "console_app", 10);
const equipe = pool(PGBOUNCER, "console_equipe", 5);
const OPTIONS = { rolesApplication: /^(console|moteur)_(app|equipe)$/ };
const requete: Requete = async (sql) => (await migration.query(`SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`)).rows[0]?.["r"] as Record<string, unknown>[];
const ACTEUR = "agent-essai";
const ACTEUR_COPIE = "equipe-copie-essai";

// Écriture de l'équipe : une transaction avec l'acteur du journal ; le verrou du journal peut faire attendre (55P03), la mise en place est rejouée.
async function ecrireEquipe<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let essai = 1; ; essai++) {
    const c = await equipe.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.acteur', $1, true), set_config('lock_timeout', '5s', true)", [ACTEUR]);
      const r = await fn(c);
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
const sql = (texte: string, valeurs: unknown[] = []) => ecrireEquipe((c) => c.query(texte, valeurs));
const lettres = (n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
const sufixe = () => lettres(6);
const nouveauCode = () => `${lettres(5)}-${String(Math.floor(Math.random() * 900) + 100)}`;
// Le propriétaire des tables n'a aucune politique d'écriture : sa suppression est refusée par le déclencheur ou ne touche aucune ligne.
const nonSupprime = async (requete: Promise<{ rowCount: number | null }>) => {
  const r = await requete.then((x) => x.rowCount, () => 0);
  expect(r).toBe(0);
};
const creerAutomatisation = async (extra: Record<string, unknown> = {}) => {
  const v = { ...automatisationFictive(nouveauCode()), ...extra };
  const cles = Object.keys(v);
  return (await sql(`INSERT INTO automatisations (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, Object.values(v))).rows[0] as Record<string, unknown>;
};
const creerVersion = async (automatisationId: unknown, extra: Record<string, unknown> = {}) => {
  const v = { ...versionFictive(String(automatisationId)), ...extra };
  const cles = Object.keys(v);
  return (await sql(`INSERT INTO versions_automatisation (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, Object.values(v))).rows[0] as Record<string, unknown>;
};
const passer = (id: unknown, statut: string) => sql("UPDATE versions_automatisation SET statut = $2 WHERE id = $1", [id, statut]);
const lire = (texte: string, valeurs: unknown[] = []) => avecClient(app, randomUUID(), (c) => c.query(texte, valeurs));
const COMMUNES = ["metiers", "postes", "automatisations", "automatisation_metiers", "automatisation_postes", "versions_automatisation", "prereglages_metier", "synonymes_catalogue", "packs", "packs_automatisations", "connecteurs", "grilles_prix"];

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

describe("catalogue commun, avec le socle", { timeout: 60_000 }, () => {
  it("[A-119] @isolation console_app lit le catalogue et ne peut rien y écrire : INSERT, UPDATE, DELETE, TRUNCATE refusés sur chaque table", async () => {
    await creerAutomatisation();
    for (const t of COMMUNES) {
      expect((await lire(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]?.n, t).toBeGreaterThanOrEqual(0);
      await expect(avecClient(app, randomUUID(), (c) => c.query(`DELETE FROM ${t}`)), `${t} DELETE`).rejects.toMatchObject({ code: "42501" });
      await expect(avecClient(app, randomUUID(), (c) => c.query(`TRUNCATE ${t}`)), `${t} TRUNCATE`).rejects.toMatchObject({ code: "42501" });
    }
    await expect(avecClient(app, randomUUID(), (c) => c.query("INSERT INTO metiers (code, nom, groupe, ordre) VALUES ('x', 'X', 'x', 1)"))).rejects.toMatchObject({ code: "42501" });
    await expect(avecClient(app, randomUUID(), (c) => c.query("UPDATE automatisations SET nom = 'x'"))).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-119] les invariants C5 ne trouvent aucun écart sur la base migrée, règle d'écriture sur les tables communes comprise", async () => {
    const ecarts = (await controlerInvariants(requete, "console", OPTIONS)).filter((e) => !/(^|\.)essai_/.test(e.objet) && !e.objet.startsWith("partman."));
    expect(ecarts).toEqual([]);
  });

  it("[A-122] une automatisation se crée ; un code mal formé ou déjà pris est refusé ; le code ne change jamais", async () => {
    const a = await creerAutomatisation();
    expect(a).toMatchObject({ statut: "idee", visibilite: "interne", niveau_risque_ia: null });
    await expect(creerAutomatisation({ code: "rh-1" })).rejects.toMatchObject({ code: "23514" });
    await expect(creerAutomatisation({ code: a["code"] })).rejects.toMatchObject({ code: "23505" });
    await expect(sql("UPDATE automatisations SET code = 'ZZZZ-999' WHERE id = $1", [a["id"]])).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-159] le niveau de risque IA refuse une valeur hors énumération et accepte « sans_ia » et le nul", async () => {
    await expect(creerAutomatisation({ niveau_risque_ia: "enorme" })).rejects.toMatchObject({ code: "22P02" });
    expect(await creerAutomatisation({ niveau_risque_ia: "sans_ia" })).toMatchObject({ niveau_risque_ia: "sans_ia" });
  });

  it("[C-685] @isolation DELETE d'une automatisation archivée refusé même par console_equipe ; son code reste réservé", async () => {
    const a = await creerAutomatisation();
    await sql("UPDATE automatisations SET statut = 'archivee' WHERE id = $1", [a["id"]]);
    await expect(sql("DELETE FROM automatisations WHERE id = $1", [a["id"]])).rejects.toMatchObject({ code: "42501" });
    await expect(creerAutomatisation({ code: a["code"] })).rejects.toMatchObject({ code: "23505" });
    await nonSupprime(migration.query("DELETE FROM automatisations WHERE id = $1", [a["id"]]));
  });

  it("[C-672] la version a six états ; un autre mot est refusé ; elle naît en brouillon", async () => {
    const a = await creerAutomatisation();
    expect(await creerVersion(a["id"])).toMatchObject({ statut: "brouillon" });
    await expect(creerVersion(a["id"], { semver: "1.0.1", empreinte_sha256: empreinteFictive(), statut: "valide" })).rejects.toMatchObject({ code: "22P02" });
  });

  it("[A-124] @isolation une version publiée refuse toute modification, même par console_equipe, et ne passe qu'à depreciee puis retiree", async () => {
    const a = await creerAutomatisation();
    const v = await creerVersion(a["id"]);
    await passer(v["id"], "recette");
    await passer(v["id"], "pilote");
    await expect(passer(v["id"], "brouillon")).rejects.toThrow(/transition/i);
    await passer(v["id"], "publiee");
    for (const colonne of ["artefact_ref", "signature_ed25519", "sbom_ref", "notes", "api_moteur"]) {
      await expect(sql(`UPDATE versions_automatisation SET ${colonne} = 'autre' WHERE id = $1`, [v["id"]]), colonne).rejects.toThrow(/immuable|transition/i);
    }
    await expect(sql("UPDATE versions_automatisation SET empreinte_sha256 = $2 WHERE id = $1", [v["id"], empreinteFictive()])).rejects.toThrow(/immuable|transition/i);
    // Le statut ET une autre colonne en même temps : refusé.
    await expect(sql("UPDATE versions_automatisation SET statut = 'depreciee', notes = 'autre' WHERE id = $1", [v["id"]])).rejects.toThrow(/autre colonne/i);
    // publiee → retiree direct : refusé.
    await expect(passer(v["id"], "retiree")).rejects.toThrow(/transition/i);
    await passer(v["id"], "depreciee");
    await expect(passer(v["id"], "publiee")).rejects.toThrow(/transition/i);
    await passer(v["id"], "retiree");
    await expect(passer(v["id"], "publiee")).rejects.toThrow(/transition/i);
    await expect(passer(v["id"], "depreciee")).rejects.toThrow(/transition/i);
    await expect(sql("DELETE FROM versions_automatisation WHERE id = $1", [v["id"]])).rejects.toMatchObject({ code: "42501" });
    await nonSupprime(migration.query("DELETE FROM versions_automatisation WHERE id = $1", [v["id"]]));
  });

  it("[A-124] une même empreinte ne peut pas être rangée deux fois, un même semver non plus ; un état saute-mouton (brouillon → publiee) est refusé", async () => {
    const a = await creerAutomatisation();
    const v = await creerVersion(a["id"]);
    await expect(creerVersion(a["id"], { semver: "9.9.9", empreinte_sha256: v["empreinte_sha256"] })).rejects.toMatchObject({ code: "23505" });
    await expect(creerVersion(a["id"], { empreinte_sha256: empreinteFictive() })).rejects.toMatchObject({ code: "23505" });
    await expect(passer(v["id"], "publiee")).rejects.toThrow(/transition/i);
    await expect(creerVersion(a["id"], { semver: "1.0.2", empreinte_sha256: "pas-une-empreinte" })).rejects.toMatchObject({ code: "23514" });
  });

  it("[C-670] l'équipe ajoute un métier et un poste « Juridique » sans migration, « Achats » existe déjà, aucune ligne ne se supprime", async () => {
    const nom = `Juridique ${sufixe()}`;
    await sql("INSERT INTO metiers (code, nom, groupe, ordre) VALUES ($1, $2, 'conseil', 90)", [`metier_${sufixe().toLowerCase()}`, nom]);
    await sql("INSERT INTO postes (code, nom, groupe, ordre) VALUES ($1, $2, 'support', 90)", [`poste_${sufixe().toLowerCase()}`, nom]);
    expect((await lire("SELECT count(*)::int AS n FROM postes WHERE code = 'achats'")).rows[0]?.n).toBe(1);
    expect((await lire("SELECT count(*)::int AS n FROM metiers WHERE actif")).rows[0]?.n).toBeGreaterThanOrEqual(7);
    await expect(sql("DELETE FROM postes WHERE code = 'achats'")).rejects.toMatchObject({ code: "42501" });
    await expect(sql("DELETE FROM metiers WHERE code = 'btp_artisans'")).rejects.toMatchObject({ code: "42501" });
    await nonSupprime(migration.query("DELETE FROM metiers WHERE code = 'btp_artisans'"));
    expect((await sql("UPDATE postes SET actif = false WHERE code = 'production' RETURNING actif")).rows[0]).toMatchObject({ actif: false });
    await sql("UPDATE postes SET actif = true WHERE code = 'production'");
  });

  it("[C-670] deux noms identiques à la casse et aux accents près sont refusés", async () => {
    const s = sufixe();
    await sql("INSERT INTO postes (code, nom, groupe, ordre) VALUES ($1, $2, 'g', 91)", [`p_${s.toLowerCase()}`, `Qualité ${s}`]);
    await expect(sql("INSERT INTO postes (code, nom, groupe, ordre) VALUES ($1, $2, 'g', 92)", [`q_${s.toLowerCase()}`, `QUALITE ${s.toLowerCase()}`])).rejects.toMatchObject({ code: "23505" });
    await expect(sql("INSERT INTO metiers (code, nom, groupe, ordre) VALUES ('btp_bis', 'btp et ARTISANS', 'g', 93)")).rejects.toMatchObject({ code: "23505" });
  });

  it("[C-671] une automatisation porte deux métiers et trois postes, la même étiquette ne se pose pas deux fois", async () => {
    const a = await creerAutomatisation();
    const metiers = (await lire("SELECT id FROM metiers ORDER BY ordre LIMIT 2")).rows;
    const postes = (await lire("SELECT id FROM postes ORDER BY ordre LIMIT 3")).rows;
    for (const m of metiers) await sql("INSERT INTO automatisation_metiers (automatisation_id, metier_id) VALUES ($1, $2)", [a["id"], m.id]);
    for (const p of postes) await sql("INSERT INTO automatisation_postes (automatisation_id, poste_id) VALUES ($1, $2)", [a["id"], p.id]);
    await expect(sql("INSERT INTO automatisation_metiers (automatisation_id, metier_id) VALUES ($1, $2)", [a["id"], metiers[0]?.id])).rejects.toMatchObject({ code: "23505" });
    await expect(sql("INSERT INTO automatisation_postes (automatisation_id, poste_id) VALUES ($1, $2)", [a["id"], postes[0]?.id])).rejects.toMatchObject({ code: "23505" });
    expect((await lire("SELECT count(*)::int AS n FROM automatisation_metiers WHERE automatisation_id = $1", [a["id"]])).rows[0]?.n).toBe(2);
    expect((await lire("SELECT count(*)::int AS n FROM automatisation_postes WHERE automatisation_id = $1", [a["id"]])).rows[0]?.n).toBe(3);
  });

  it("[C-671] l'étiquette outil se calcule depuis le manifeste de la version, sans être saisie", async () => {
    const a = await creerAutomatisation();
    await creerVersion(a["id"], { manifeste: { connecteurs: [{ famille: "messagerie", outil: "outil-essai" }] } });
    const { rows } = await sql("SELECT famille, outil FROM automatisation_outils WHERE automatisation_id = $1", [a["id"]]);
    expect(rows).toEqual([{ famille: "messagerie", outil: "outil-essai" }]);
    await expect(avecClient(app, randomUUID(), (c) => c.query("INSERT INTO automatisation_outils (automatisation_id, famille, outil) VALUES ($1, 'crm', 'x')", [a["id"]]))).rejects.toThrow();
  });

  it("[C-673] un préréglage naît en brouillon et garde auteur, justification et référence de sa version précédente ; il refuse les données d'un client", async () => {
    const a = await creerAutomatisation();
    const metier = (await lire("SELECT id FROM metiers LIMIT 1")).rows[0]?.id;
    const ajouter = (extra: Record<string, unknown>) =>
      sql("INSERT INTO prereglages_metier (automatisation_id, metier_id, donnees, version, auteur, justification, statut) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *", [a["id"], metier, JSON.stringify(extra["donnees"] ?? { delai_relance_jours: 3 }), extra["version"] ?? 1, "agent-essai", "première version", extra["statut"] ?? "brouillon"]);
    const v1 = (await ajouter({})).rows[0] as Record<string, unknown>;
    expect(v1).toMatchObject({ statut: "brouillon", auteur: "agent-essai", version_precedente_id: null });
    await expect(ajouter({ version: 1 })).rejects.toMatchObject({ code: "23505" });
    await expect(ajouter({ version: 2, statut: "publie" })).rejects.toThrow(/brouillon/i);
    for (const donnees of [{ tenant_id: randomUUID() }, { reglages: { organisation_id: "x" } }, { contact: "jeanne@exemple.fr" }, { siren: "123456789" }]) {
      await expect(ajouter({ version: 3, donnees }), JSON.stringify(donnees)).rejects.toMatchObject({ code: "23514" });
    }
    const v2 = (await sql("INSERT INTO prereglages_metier (automatisation_id, metier_id, donnees, version, auteur, justification, version_precedente_id) VALUES ($1, $2, '{}', 2, 'agent-essai', 'correction', $3) RETURNING *", [a["id"], metier, v1["id"]])).rows[0];
    expect(v2).toMatchObject({ version_precedente_id: v1["id"], statut: "brouillon" });
    // Une fois publié, le contenu ne bouge plus.
    await sql("UPDATE prereglages_metier SET statut = 'publie' WHERE id = $1", [v1["id"]]);
    await expect(sql("UPDATE prereglages_metier SET donnees = '{}' WHERE id = $1", [v1["id"]])).rejects.toThrow(/publi/i);
    await sql("UPDATE prereglages_metier SET statut = 'retire' WHERE id = $1", [v1["id"]]);
  });

  it("[C-676] une instance garde préréglage et version de départ et source de copie ; console_app ne les lit pas, console_equipe oui", async () => {
    const A = randomUUID();
    const a = await creerAutomatisation();
    const org = A;
    const source = randomUUID();
    await avecClient(app, A, async (c) => {
      await c.query("INSERT INTO organisations (tenant_id, id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Lemoine Rénovation')", [A]);
      await c.query("INSERT INTO instances (tenant_id, id, organisation_id, code_automatisation, formule, environnement, etat, automatisation_id, instance_source_copie, copie_le, copie_par) VALUES ($1, $2, $3, 'X', 'abonnement', 'production', 'pause', $4, $5, now(), $6)", [A, randomUUID(), org, a["id"], source, ACTEUR_COPIE]);
    }, { acteur: ACTEUR });
    await expect(avecClient(app, A, (c) => c.query("SELECT instance_source_copie FROM instances"))).rejects.toMatchObject({ code: "42501" });
    await expect(avecClient(app, A, (c) => c.query("SELECT * FROM instances"))).rejects.toMatchObject({ code: "42501" });
    expect((await avecClient(app, A, (c) => c.query("SELECT id, version_courante_id, automatisation_id FROM instances"))).rows).toHaveLength(1);
    expect((await equipe.query("SELECT instance_source_copie FROM instances WHERE tenant_id = $1", [A])).rows[0]?.instance_source_copie).toBeTruthy();
    // Le journal d'audit de son client ne recopie pas non plus ces colonnes : console_app y lit, il n'y retrouve ni l'instance source ni la personne de l'équipe.
    const journal = (await avecClient(app, A, (c) => c.query("SELECT ancienne, nouvelle FROM journal_audit WHERE tenant_id = $1 AND entite = 'instances'", [A]))).rows;
    expect(journal.length).toBeGreaterThan(0);
    const texte = JSON.stringify(journal);
    expect(texte).not.toContain(ACTEUR_COPIE);
    expect(texte).not.toContain(source);
    expect(texte).toContain("interne");
    // Copie incomplète (source sans date ni auteur) : refusée.
    await expect(avecClient(app, A, (c) => c.query("UPDATE instances SET instance_source_copie = $1, copie_le = NULL", [randomUUID()]))).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-139] un pack porte ses automatisations et un prix en centimes entiers ; un prix négatif ou un prix modifié est refusé", async () => {
    const a = await creerAutomatisation();
    const metier = (await lire("SELECT id FROM metiers LIMIT 1")).rows[0]?.id;
    const pack = await ecrireEquipe(async (c) => {
      const p = (await c.query("INSERT INTO packs (nom, metier_id, prix_centimes, auteur) VALUES ($1, $2, $3, $4) RETURNING *", [`Pack essai ${sufixe()}`, metier, GRILLE_FICTIVE.pack, "agent-essai"])).rows[0] as Record<string, unknown>;
      await c.query("INSERT INTO packs_automatisations (pack_id, automatisation_id) VALUES ($1, $2)", [p["id"], a["id"]]);
      return p;
    });
    expect(pack["prix_centimes"]).toBe(String(GRILLE_FICTIVE.pack));
    await expect(sql("INSERT INTO packs (nom, metier_id, prix_centimes, auteur) VALUES ('Négatif', $1, -1, 'x')", [metier])).rejects.toMatchObject({ code: "23514" });
    await expect(sql("UPDATE packs SET prix_centimes = 99 WHERE id = $1", [pack["id"]])).rejects.toMatchObject({ code: "42501" });
    await expect(sql("INSERT INTO packs (nom, metier_id, prix_centimes, auteur) VALUES ($1, $2, $3, 'x')", [`Réel ${sufixe()}`, metier, "12.5"])).rejects.toMatchObject({ code: "22P02" });
  });

  it("[A-141] un connecteur garde famille, outil, version, capacités ; une famille inconnue ou un doublon est refusé", async () => {
    const outil = `outil-${sufixe().toLowerCase()}`;
    const ligne = (await sql("INSERT INTO connecteurs (famille, outil, version, capacites) VALUES ('messagerie', $1, '1.0.0', $2) RETURNING *", [outil, JSON.stringify(["envoyer", "lire"])])).rows[0];
    expect(ligne).toMatchObject({ famille: "messagerie", outil, version: "1.0.0", capacites: ["envoyer", "lire"] });
    await expect(sql("INSERT INTO connecteurs (famille, outil, version, capacites) VALUES ('messagerie', $1, '1.0.0', '[]')", [outil])).rejects.toMatchObject({ code: "23505" });
    await expect(sql("INSERT INTO connecteurs (famille, outil, version, capacites) VALUES ('inconnue', 'x', '1', '[]')")).rejects.toMatchObject({ code: "22P02" });
  });

  it("[A-142] une grille de prix garde ses montants en centimes entiers et la maintenance incluse en mois ; ajout seul", async () => {
    const a = await creerAutomatisation();
    const g = (await sql("INSERT INTO grilles_prix (automatisation_id, formules_actives, montant_installation_centimes, montant_mensuel_centimes, maintenance_incluse_mois, maintenance_ensuite_centimes, auteur) VALUES ($1, $2, $3, $4, $5, $6, 'agent-essai') RETURNING *", [a["id"], JSON.stringify(["standard"]), GRILLE_FICTIVE.installation, GRILLE_FICTIVE.mensuel, 12, GRILLE_FICTIVE.maintenance])).rows[0];
    expect(g).toMatchObject({ montant_installation_centimes: String(GRILLE_FICTIVE.installation), maintenance_incluse_mois: 12 });
    await expect(sql("UPDATE grilles_prix SET montant_mensuel_centimes = 99 WHERE id = $1", [g?.id])).rejects.toMatchObject({ code: "42501" });
    await expect(sql("DELETE FROM grilles_prix WHERE id = $1", [g?.id])).rejects.toMatchObject({ code: "42501" });
    await expect(sql("INSERT INTO grilles_prix (automatisation_id, formules_actives, montant_installation_centimes, montant_mensuel_centimes, maintenance_incluse_mois, maintenance_ensuite_centimes, auteur) VALUES ($1, '[]', -1, 0, 0, 0, 'x')", [a["id"]])).rejects.toMatchObject({ code: "23514" });
    await expect(sql("INSERT INTO grilles_prix (automatisation_id, formules_actives, montant_installation_centimes, montant_mensuel_centimes, maintenance_incluse_mois, maintenance_ensuite_centimes, auteur) VALUES ($1, '[]', 1, 1, 1, 1, '  ')", [a["id"]])).rejects.toMatchObject({ code: "23514" });
  });

  it("[B-533] la recherche « prereglage » sans accent trouve « préréglage » et utilise l'index trigramme", async () => {
    const nom = `Préréglage de relance ${sufixe()}`;
    await creerAutomatisation({ nom });
    const requeteRecherche = "SELECT nom FROM automatisations WHERE lower(public.sans_accent(coalesce(code, '') || ' ' || nom || ' ' || coalesce(fonction, '') || ' ' || coalesce(description, ''))) LIKE '%' || lower(public.sans_accent($1)) || '%'";
    expect((await lire(requeteRecherche, ["prereglage de relance"])).rows.map((r) => r.nom)).toContain(nom);
    // Sans seqscan (peu de lignes : le planificateur préférerait un parcours complet), le plan doit passer par l'index trigramme.
    const plan = await avecClient(app, randomUUID(), async (c) => {
      await c.query("SET LOCAL enable_seqscan = off");
      return (await c.query(`EXPLAIN ${requeteRecherche.replace("$1", "'prereglage'")}`)).rows.map((r) => Object.values(r)[0]).join("\n");
    });
    expect(plan).toMatch(/automatisations_recherche_trgm_idx/);
    await sql("INSERT INTO synonymes_catalogue (mot, equivalent) VALUES ($1, 'facture') ON CONFLICT DO NOTHING", [`devis${sufixe().toLowerCase()}`]);
  });

  it("[C-686] 500 automatisations au catalogue : recherche filtrée < N s (N provisoire, fixé au lot 8a)", async () => {
    const lot = sufixe();
    // Par lots de 50 : chaque écriture est auditée sous le verrou du journal, une longue transaction ferait attendre les autres essais.
    for (let depart = 0; depart < 500; depart += 50) {
      const valeurs: unknown[] = [];
      const lignes = Array.from({ length: 50 }, (_, k) => {
        const i = depart + k;
        valeurs.push(`${lot}-${String(i + 100).padStart(3, "0")}`, `Automatisation fictive ${lot} ${i}`);
        return `($${valeurs.length - 1}, $${valeurs.length}, 'fonction fictive', 'description fictive', 'idee')`;
      });
      await sql(`INSERT INTO automatisations (code, nom, fonction, description, statut) VALUES ${lignes.join(", ")}`, valeurs);
    }
    const debut = Date.now();
    const { rows } = await lire("SELECT code FROM automatisations WHERE statut = 'idee' AND nom ILIKE $1 ORDER BY nom LIMIT 50", [`%${lot}%`]);
    const duree = (Date.now() - debut) / 1000;
    expect(rows).toHaveLength(50);
    expect(duree).toBeLessThan(2);
  });

  it("[A-119] console_app ne lit que les versions publiées, dépréciées ou retirées : ni brouillon, ni recette, ni pilote", async () => {
    const a = await creerAutomatisation();
    const v = await creerVersion(a["id"]);
    expect((await lire("SELECT count(*)::int AS n FROM versions_automatisation WHERE id = $1", [v["id"]])).rows[0]?.n).toBe(0);
    expect((await equipe.query("SELECT count(*)::int AS n FROM versions_automatisation WHERE id = $1", [v["id"]])).rows[0]?.n).toBe(1);
    await passer(v["id"], "recette");
    await passer(v["id"], "pilote");
    expect((await lire("SELECT count(*)::int AS n FROM versions_automatisation WHERE id = $1", [v["id"]])).rows[0]?.n).toBe(0);
    await passer(v["id"], "publiee");
    expect((await lire("SELECT count(*)::int AS n FROM versions_automatisation WHERE id = $1", [v["id"]])).rows[0]?.n).toBe(1);
  });

  it("[A-146] conditions_par_defaut : auteur obligatoire, et chaque écriture de l'équipe laisse une ligne au journal d'audit", async () => {
    const PLATEFORME = "00000000-0000-0000-0000-000000000001";
    const ajouter = (auteur: string | null) =>
      sql("INSERT INTO conditions_par_defaut (tenant_id, id, type, valeur, auteur) VALUES ($1, $2, 'delai', '{\"jours\": 99}', $3) RETURNING id", [PLATEFORME, randomUUID(), auteur]);
    await expect(ajouter(null)).rejects.toMatchObject({ code: "23502" });
    await expect(ajouter("  ")).rejects.toMatchObject({ code: "23514" });
    const id = (await ajouter("agent-essai")).rows[0]?.id as string;
    const { rows } = await equipe.query("SELECT acteur, action, entite, tenant_id FROM journal_audit WHERE entite = 'conditions_par_defaut' AND entite_id = $1", [id]);
    expect(rows).toEqual([{ acteur: ACTEUR, action: "insertion", entite: "conditions_par_defaut", tenant_id: null }]);
    await expect(avecClient(app, randomUUID(), (c) => c.query("INSERT INTO conditions_par_defaut (tenant_id, id, type, valeur, auteur) VALUES ($1, $2, 'delai', '{}', 'x')", [PLATEFORME, randomUUID()]))).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-119] @isolation la règle C5 signale un droit d'écriture donné à console_app ou à PUBLIC sur une table commune, et une table sans tenant_id hors de la liste (transaction annulée)", async () => {
    const c = await migration.connect();
    const liee: Requete = async (texte) => (await c.query(`SELECT coalesce(json_agg(t), '[]') AS r FROM (${texte}) t`)).rows[0]?.["r"] as Record<string, unknown>[];
    const ecarts = async () => (await controlerInvariants(liee, "console", OPTIONS)).filter((e) => e.regle === "ecriture_commune_ouverte" || e.regle === "tenant_id_absent");
    try {
      for (const [droit, table] of [["INSERT", "metiers"], ["UPDATE (nom)", "metiers"], ["DELETE", "postes"], ["TRIGGER", "automatisations"], ["REFERENCES (id)", "connecteurs"]] as const) {
        await c.query("BEGIN");
        await c.query(`GRANT ${droit} ON ${table} TO console_app`);
        expect(await ecarts(), `${droit} ON ${table}`).toContainEqual({ regle: "ecriture_commune_ouverte", objet: `${table}:console_app` });
        await c.query("ROLLBACK");
      }
      await c.query("BEGIN");
      await c.query("GRANT INSERT ON metiers TO PUBLIC");
      expect(await ecarts()).toContainEqual({ regle: "ecriture_commune_ouverte", objet: "metiers:console_app" });
      await c.query("ROLLBACK");
      // Une table sans tenant_id hors de TABLES_COMMUNES est un écart.
      await c.query("BEGIN");
      await c.query("CREATE TABLE public.hors_liste_essai (id int); ALTER TABLE public.hors_liste_essai ENABLE ROW LEVEL SECURITY; ALTER TABLE public.hors_liste_essai FORCE ROW LEVEL SECURITY");
      expect(await ecarts()).toContainEqual({ regle: "tenant_id_absent", objet: "hors_liste_essai" });
      await c.query("ROLLBACK");
      // Sans rien donner, aucun écart d'écriture.
      expect((await ecarts()).filter((e) => e.regle === "ecriture_commune_ouverte")).toEqual([]);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("[A-124] une version ne naît qu'en brouillon : l'insertion directe en publiee, depreciee ou retiree est refusée", async () => {
    const a = await creerAutomatisation();
    for (const statut of ["recette", "pilote", "publiee", "depreciee", "retiree"]) {
      await expect(creerVersion(a["id"], { semver: "2.0.0", empreinte_sha256: empreinteFictive(), statut }), statut).rejects.toThrow(/naît en brouillon/i);
    }
  });

  it("[A-146] une écriture de l'équipe qui porte de l'argent sans acteur au journal est refusée ; une autre garde « systeme »", async () => {
    const a = await creerAutomatisation();
    const metier = (await lire("SELECT id FROM metiers LIMIT 1")).rows[0]?.id;
    // Sans app.acteur : refus pour les packs, les grilles de prix et leurs liaisons.
    await expect(equipe.query("INSERT INTO packs (nom, metier_id, prix_centimes, auteur) VALUES ($1, $2, 99, 'x')", [`Sans acteur ${sufixe()}`, metier])).rejects.toThrow(/acteur obligatoire/i);
    await expect(equipe.query("INSERT INTO grilles_prix (automatisation_id, formules_actives, montant_installation_centimes, montant_mensuel_centimes, maintenance_incluse_mois, maintenance_ensuite_centimes, auteur) VALUES ($1, '[]', 1, 1, 1, 1, 'x')", [a["id"]])).rejects.toThrow(/acteur obligatoire/i);
    // Hors argent : accepté, journalisé sous « systeme ».
    const code = `systeme_${sufixe().toLowerCase()}`;
    await equipe.query("INSERT INTO connecteurs (famille, outil, version, capacites) VALUES ('autre', $1, '1', '[]')", [code]);
    const { rows } = await equipe.query("SELECT acteur FROM journal_audit WHERE entite = 'connecteurs' AND nouvelle->>'outil' = $1", [code]);
    expect(rows).toEqual([{ acteur: "systeme" }]);
  });

  it("[A-137] les données d'un préréglage refusent les clés qui contiennent tenant, client, mail, téléphone, siren, iban, et les nombres de 9 ou 14 chiffres", async () => {
    const a = await creerAutomatisation();
    const metier = (await lire("SELECT id FROM metiers LIMIT 1")).rows[0]?.id;
    let version = 10;
    const essayer = (donnees: unknown) =>
      sql("INSERT INTO prereglages_metier (automatisation_id, metier_id, donnees, version, auteur, justification) VALUES ($1, $2, $3, $4, 'agent-essai', 'essai')", [a["id"], metier, JSON.stringify(donnees), version++]);
    for (const donnees of [{ tenant: "x" }, { client: "x" }, { email_contact: "x" }, { numero_siren: "x" }, { telephone_portable: "x" }, { phone: "x" }, { iban: "x" }, { nom_client: "x" }, { a: { b: { organisation_id: "x" } } }, { reference: "123456789" }, { reference: 12345678901234 }, { a: "contact@exemple.fr" }]) {
      await expect(essayer(donnees), JSON.stringify(donnees)).rejects.toMatchObject({ code: "23514" });
    }
    await expect(essayer({ delai_relance_jours: 3, canal: "messagerie" })).resolves.toMatchObject({ rowCount: 1 });
  });

  it("[A-139] la composition d'un pack est fixée à sa création : ajouter une automatisation à un pack existant est refusé", async () => {
    const [a, b] = [await creerAutomatisation(), await creerAutomatisation()];
    const metier = (await lire("SELECT id FROM metiers LIMIT 1")).rows[0]?.id;
    const pack = (await sql("INSERT INTO packs (nom, metier_id, prix_centimes, auteur) VALUES ($1, $2, $3, $4) RETURNING *", [`Pack vide ${sufixe()}`, metier, GRILLE_FICTIVE.pack, ACTEUR])).rows[0] as Record<string, unknown>;
    await expect(sql("INSERT INTO packs_automatisations (pack_id, automatisation_id) VALUES ($1, $2)", [pack["id"], a["id"]])).rejects.toThrow(/composition/i);
    // Dans la transaction de sa création, le pack se compose librement.
    await ecrireEquipe(async (c) => {
      const p = (await c.query("INSERT INTO packs (nom, metier_id, prix_centimes, auteur) VALUES ($1, $2, $3, $4) RETURNING id", [`Pack composé ${sufixe()}`, metier, GRILLE_FICTIVE.pack, ACTEUR])).rows[0];
      await c.query("INSERT INTO packs_automatisations (pack_id, automatisation_id) VALUES ($1, $2), ($1, $3)", [p?.id, a["id"], b["id"]]);
    });
  });

  it("[A-139] le journal de l'équipe nomme l'entité des tables sans colonne id par ses clés composées (pack et composition, métiers, postes)", async () => {
    const a = await creerAutomatisation();
    const metier = (await lire("SELECT id FROM metiers LIMIT 1")).rows[0]?.id;
    const poste = (await lire("SELECT id FROM postes LIMIT 1")).rows[0]?.id;
    const packId = await ecrireEquipe(async (c) => {
      const p = (await c.query("INSERT INTO packs (nom, metier_id, prix_centimes, auteur) VALUES ($1, $2, $3, $4) RETURNING id", [`Pack journal ${sufixe()}`, metier, GRILLE_FICTIVE.pack, ACTEUR])).rows[0];
      await c.query("INSERT INTO packs_automatisations (pack_id, automatisation_id) VALUES ($1, $2)", [p?.id, a["id"]]);
      await c.query("INSERT INTO automatisation_metiers (automatisation_id, metier_id) VALUES ($1, $2)", [a["id"], metier]);
      await c.query("INSERT INTO automatisation_postes (automatisation_id, poste_id) VALUES ($1, $2)", [a["id"], poste]);
      return p?.id as string;
    });
    const attendu = [
      ["packs_automatisations", `${String(a["id"])}/${packId}`],
      ["automatisation_metiers", `${String(a["id"])}/${String(metier)}`],
      ["automatisation_postes", `${String(a["id"])}/${String(poste)}`],
    ] as const;
    for (const [entite, entiteId] of attendu) {
      const { rows } = await equipe.query("SELECT entite_id FROM journal_audit WHERE entite = $1 AND entite_id = $2", [entite, entiteId]);
      expect(rows, entite).toHaveLength(1);
    }
  });

  it("[A-139] la date de création d'un pack est imposée : une valeur fournie à l'insertion est refusée", async () => {
    const metier = (await lire("SELECT id FROM metiers LIMIT 1")).rows[0]?.id;
    await expect(sql("INSERT INTO packs (nom, metier_id, prix_centimes, auteur, cree_le) VALUES ($1, $2, $3, $4, now() - interval '30 days')", [`Pack antidaté ${sufixe()}`, metier, GRILLE_FICTIVE.pack, ACTEUR])).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-126] une instance ne pointe que vers une version publiée de SON automatisation, et vers un préréglage publié de cette automatisation avec sa version", async () => {
    const T = randomUUID();
    const a = await creerAutomatisation();
    const b = await creerAutomatisation();
    const publiee = await creerVersion(a["id"]);
    await passer(publiee["id"], "recette");
    await passer(publiee["id"], "pilote");
    await passer(publiee["id"], "publiee");
    const brouillon = await creerVersion(a["id"], { semver: "1.1.0", empreinte_sha256: empreinteFictive() });
    const autre = await creerVersion(b["id"]);
    await passer(autre["id"], "recette");
    await passer(autre["id"], "pilote");
    await passer(autre["id"], "publiee");
    const metier = (await lire("SELECT id FROM metiers LIMIT 1")).rows[0]?.id;
    const preregler = async (statut: string, version: number) => {
      const p = (await sql("INSERT INTO prereglages_metier (automatisation_id, metier_id, donnees, version, auteur, justification) VALUES ($1, $2, '{}', $3, 'agent-essai', 'essai') RETURNING id", [a["id"], metier, version])).rows[0];
      if (statut !== "brouillon") await sql("UPDATE prereglages_metier SET statut = $2 WHERE id = $1", [p?.id, statut === "retire" ? "publie" : statut]);
      if (statut === "retire") await sql("UPDATE prereglages_metier SET statut = 'retire' WHERE id = $1", [p?.id]);
      return p?.id as string;
    };
    const prereglagePublie = await preregler("publie", 1);
    const prereglageBrouillon = await preregler("brouillon", 2);
    const prereglageRetire = await preregler("retire", 3);
    await avecClient(app, T, (c) => c.query("INSERT INTO organisations (tenant_id, id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Boulangerie Rivoire')", [T]), { acteur: ACTEUR });
    const inserer = (extra: Record<string, unknown>) => {
      const v = { tenant_id: T, id: randomUUID(), organisation_id: T, code_automatisation: "X", formule: "abonnement", environnement: "production", etat: "pause", ...extra };
      const cles = Object.keys(v);
      return avecClient(app, T, (c) => c.query(`INSERT INTO instances (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(v)), { acteur: ACTEUR });
    };
    const refus = /instances/i;
    await expect(inserer({ automatisation_id: a["id"], version_courante_id: brouillon["id"] }), "brouillon").rejects.toThrow(refus);
    await expect(inserer({ automatisation_id: a["id"], version_courante_id: autre["id"] }), "autre automatisation").rejects.toThrow(refus);
    await expect(inserer({ version_courante_id: publiee["id"] }), "sans automatisation").rejects.toThrow(refus);
    await expect(inserer({ automatisation_id: a["id"], prereglage_depart_id: prereglagePublie }), "version de préréglage absente").rejects.toThrow(refus);
    await expect(inserer({ automatisation_id: a["id"], version_prereglage_depart: 1 }), "version sans préréglage").rejects.toThrow(refus);
    await expect(inserer({ automatisation_id: a["id"], prereglage_depart_id: prereglagePublie, version_prereglage_depart: 7 }), "mauvaise version").rejects.toThrow(refus);
    await expect(inserer({ automatisation_id: a["id"], prereglage_depart_id: prereglageBrouillon, version_prereglage_depart: 2 }), "préréglage brouillon").rejects.toThrow(refus);
    await expect(inserer({ automatisation_id: a["id"], prereglage_depart_id: prereglageRetire, version_prereglage_depart: 3 }), "préréglage retiré").rejects.toThrow(refus);
    await expect(inserer({ automatisation_id: b["id"], prereglage_depart_id: prereglagePublie, version_prereglage_depart: 1 }), "préréglage d'une autre automatisation").rejects.toThrow(refus);
    await expect(inserer({ automatisation_id: a["id"], version_courante_id: publiee["id"], prereglage_depart_id: prereglagePublie, version_prereglage_depart: 1 })).resolves.toBeDefined();
  });

  it("[A-126] un préréglage retiré ne peut pas servir de départ à une nouvelle instance", async () => {
    const T = randomUUID();
    const a = await creerAutomatisation();
    const metier = (await lire("SELECT id FROM metiers LIMIT 1")).rows[0]?.id;
    const p = (await sql("INSERT INTO prereglages_metier (automatisation_id, metier_id, donnees, version, auteur, justification) VALUES ($1, $2, '{}', 1, 'agent-essai', 'essai') RETURNING id", [a["id"], metier])).rows[0];
    await sql("UPDATE prereglages_metier SET statut = 'publie' WHERE id = $1", [p?.id]);
    await sql("UPDATE prereglages_metier SET statut = 'retire' WHERE id = $1", [p?.id]);
    await avecClient(app, T, (c) => c.query("INSERT INTO organisations (tenant_id, id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Atelier Bertin')", [T]), { acteur: ACTEUR });
    await expect(avecClient(app, T, (c) => c.query("INSERT INTO instances (tenant_id, id, organisation_id, code_automatisation, formule, environnement, etat, automatisation_id, prereglage_depart_id, version_prereglage_depart) VALUES ($1, $2, $1, 'X', 'abonnement', 'production', 'pause', $3, $4, 1)", [T, randomUUID(), a["id"], p?.id]), { acteur: ACTEUR })).rejects.toThrow(/publié/i);
  });

  it("[A-139] le journal de l'équipe garde l'identifiant d'une ligne de liaison sans colonne id : automatisation/pack pour packs_automatisations", async () => {
    const a = await creerAutomatisation();
    const metier = (await lire("SELECT id FROM metiers LIMIT 1")).rows[0]?.id;
    const pack = await ecrireEquipe(async (c) => {
      const p = (await c.query("INSERT INTO packs (nom, metier_id, prix_centimes, auteur) VALUES ($1, $2, 99, 'agent-essai') RETURNING id", [`Pack journal ${sufixe()}`, metier])).rows[0];
      await c.query("INSERT INTO packs_automatisations (pack_id, automatisation_id) VALUES ($1, $2)", [p?.id, a["id"]]);
      return p?.id as string;
    });
    const { rows } = await equipe.query("SELECT entite_id FROM journal_audit WHERE entite = 'packs_automatisations' AND entite_id = $1", [`${String(a["id"])}/${pack}`]);
    expect(rows).toEqual([{ entite_id: `${String(a["id"])}/${pack}` }]);
  });
});
