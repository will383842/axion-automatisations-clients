import { writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, EXCEPTIONS_UNICITE, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Le rapport de la CI est un JSON hors du journal : un essai en échec est écrit par writeSync(2, …), lisible dans le journal du job.
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

// Registre des bases des clients et fin de contrat (T2-30), contre le socle lancé par ops/socle/lancer.sh (job socle-integration).
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
const SCHEMA = "essai_t230";
const nomDe = (tenant: string) => `cli_${tenant.replaceAll("-", "")}`;
const TABLES_FIN_DE_VIE = ["propositions_suppression", "reglages_fin_de_contrat", "demandes_effacement", "decisions_effacement", "confirmations_mise_a_l_ecart"];

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
  return ecrire(app, tenant, async (c) => (await c.query(`INSERT INTO ${table} (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, Object.values(v))).rows[0] as Record<string, unknown>, APPELANT);
};
const creerOrg = (id: string) => inserer(id, "organisations", { id, console_client_id: id, raison_sociale: "Atelier Bertin" });
const creerBase = (A: string, extra: Record<string, unknown> = {}) => inserer(A, "bases_client", { organisation_id: A, grappe: "donnees-1", nom_base: nomDe(A), ...extra });
const creerFin = (A: string) => inserer(A, "fins_de_contrat", { organisation_id: A, date_fin: "2027-03-31" });
const creerGel = (A: string, extra: Record<string, unknown> = {}) => inserer(A, "gels_litige", { organisation_id: A, motif_litige: "litige d'essai", posee_par: "agent-essai", ...extra });
const creerProposition = (A: string, fin: unknown, echeance = "2029-03-31", extra: Record<string, unknown> = {}) => inserer(A, "propositions_suppression", { fin_de_contrat_id: fin, echeance, ...extra });
async function nouveauClient(): Promise<string> {
  const A = randomUUID();
  await creerOrg(A);
  return A;
}

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await migration.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

describe("registre des bases des clients, avec le socle", { timeout: 30_000 }, () => {
  it("[A-135] une base client s'inscrit avec grappe, nom, version, taille, quota et état en_creation", async () => {
    const A = await nouveauClient();
    const base = await creerBase(A, { version_structure: 3, taille_octets: 1048576, quota_base_octets: 5368709120, quota_fichiers_octets: 10737418240, quota_personnes: 25 });
    expect(base).toMatchObject({ grappe: "donnees-1", nom_base: nomDe(A), version_structure: 3, etat: "en_creation", etape_provisionnement: 0, derniere_erreur: null, derniere_sauvegarde: null, dernier_test_restauration: null, quota_personnes: 25 });
    // Une erreur ne garde qu'un code, jamais un texte libre.
    await ecrire(app, A, (c) => c.query("UPDATE bases_client SET derniere_erreur = 'creation_base_echec', etape_provisionnement = 2 WHERE id = $1", [base["id"]]), APPELANT);
    await expect(ecrire(app, A, (c) => c.query("UPDATE bases_client SET derniere_erreur = 'mot de passe: abc' WHERE id = $1", [base["id"]]))).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-135] l'état refuse une valeur hors énumération ; l'état a_l_ecart existe", async () => {
    const A = await nouveauClient();
    const base = await creerBase(A);
    for (const etat of ["active", "gelee", "exportee", "a_l_ecart", "effacee"]) {
      expect((await ecrire(app, A, (c) => c.query("UPDATE bases_client SET etat = $2 WHERE id = $1 RETURNING etat", [base["id"], etat]), APPELANT)).rows[0]?.etat).toBe(etat);
    }
    await expect(ecrire(app, A, (c) => c.query("UPDATE bases_client SET etat = 'detruite' WHERE id = $1", [base["id"]]))).rejects.toMatchObject({ code: "22P02" });
  });

  it("[A-135] @isolation console_app avec le client A ne lit aucune base de B", async () => {
    const A = await nouveauClient();
    const B = await nouveauClient();
    await creerBase(B);
    const base = await creerBase(A);
    await ecrire(app, A, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM bases_client WHERE tenant_id = $1", [B])).rows[0]?.n).toBe(0);
      expect((await c.query("UPDATE bases_client SET etat = 'gelee' WHERE tenant_id = $1", [B])).rowCount).toBe(0);
      expect((await c.query("SELECT count(*)::int AS n FROM bases_client")).rows[0]?.n).toBe(1);
    }, APPELANT);
    expect(base["tenant_id"]).toBe(A);
    // Une base rattachée à l'organisation de B (clé étrangère composée) ou écrite au nom de B (WITH CHECK) est refusée.
    await expect(inserer(A, "bases_client", { organisation_id: B, grappe: "donnees-1", nom_base: nomDe(A), id: randomUUID() })).rejects.toThrow();
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO bases_client (id, tenant_id, organisation_id, grappe, nom_base) VALUES ($1, $2, $2, 'donnees-1', $3)", [randomUUID(), B, nomDe(B)]))).rejects.toMatchObject({ code: "42501" });
    expect((await app.query("SELECT count(*)::int AS n FROM bases_client")).rows[0]?.n).toBe(0);
  });

  it("[A-225] une version de structure appliquée à une base est enregistrée avec son résultat", async () => {
    const A = await nouveauClient();
    const base = await creerBase(A);
    for (const resultat of ["ok", "echec", "quarantaine"]) {
      expect(await inserer(A, "versions_structure", { base_id: base["id"], version: 4, resultat, vague: 2 })).toMatchObject({ resultat, version: 4, vague: 2 });
    }
    await expect(inserer(A, "versions_structure", { base_id: base["id"], version: 5, resultat: "inconnu" })).rejects.toMatchObject({ code: "22P02" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE versions_structure SET resultat = 'ok'"))).rejects.toMatchObject({ code: "42501" });
  });

  it("[C-609] un gel se pose avec motif, date et auteur, et sa levée garde l'historique (aucune ligne supprimée)", async () => {
    const A = await nouveauClient();
    const gel = await creerGel(A);
    expect(gel).toMatchObject({ motif_litige: "litige d'essai", posee_par: "agent-essai", levee_le: null, leve_par: null });
    expect(gel["posee_le"]).toBeInstanceOf(Date);
    await expect(creerGel(A, { motif_litige: "   " })).rejects.toMatchObject({ code: "23514" });
    await ecrire(app, A, (c) => c.query("UPDATE gels_litige SET levee_le = now(), leve_par = 'agent-essai' WHERE id = $1", [gel["id"]]), APPELANT);
    await expect(ecrire(app, A, (c) => c.query("DELETE FROM gels_litige WHERE id = $1", [gel["id"]]))).rejects.toMatchObject({ code: "42501" });
    // Seule la levée se modifie : le motif et l'auteur de la pose ne changent pas.
    await expect(ecrire(app, A, (c) => c.query("UPDATE gels_litige SET motif_litige = 'autre' WHERE id = $1", [gel["id"]]))).rejects.toMatchObject({ code: "42501" });
    const { rows } = await ecrire(app, A, (c) => c.query("SELECT motif_litige, levee_le, leve_par FROM gels_litige WHERE id = $1", [gel["id"]]));
    expect(rows[0]).toMatchObject({ motif_litige: "litige d'essai", leve_par: "agent-essai" });
    expect(rows[0]?.levee_le).toBeInstanceOf(Date);
  });

  it("[A-158] la visibilité garde les accords écrits datés et l'accès d'intervention avec début et fin", async () => {
    const A = await nouveauClient();
    const v = await inserer(A, "visibilite_acces", { organisation_id: A, lien_retour: "https://exemple.fr/retour", page_reference: "https://exemple.fr/reference", accords_ecrits_le: ["2027-01-15", "2027-02-01"], intervention_perimetre: "lecture des relances", intervention_debut: "2027-03-01T08:00:00Z", intervention_fin: "2027-03-02T08:00:00Z" });
    expect(v).toMatchObject({ lien_retour: "https://exemple.fr/retour", intervention_perimetre: "lecture des relances" });
    expect((v["accords_ecrits_le"] as unknown[]).length).toBe(2);
    expect(v["intervention_debut"]).toBeInstanceOf(Date);
    // Fin avant le début, ou intervention incomplète : refusées.
    const B = await nouveauClient();
    await expect(inserer(B, "visibilite_acces", { organisation_id: B, intervention_perimetre: "x", intervention_debut: "2027-03-02T08:00:00Z", intervention_fin: "2027-03-01T08:00:00Z" })).rejects.toMatchObject({ code: "23514" });
    await expect(inserer(B, "visibilite_acces", { organisation_id: B, intervention_perimetre: "x" })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-119] toutes les migrations appliquées, les invariants C5 ne trouvent aucun écart", async () => {
    const ecarts = (await controlerInvariants(requete, "console", OPTIONS)).filter((e) => !/(^|\.)essai_/.test(e.objet) && !e.objet.startsWith("partman."));
    expect(ecarts).toEqual([]);
    const { rows } = await migration.query("SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY 1", [["bases_client", "versions_structure", "fins_de_contrat", "confirmations_mise_a_l_ecart", "demandes_effacement", "decisions_effacement", "propositions_suppression", "reglages_fin_de_contrat", "attestations_fin_de_contrat", "gels_litige", "visibilite_acces"]]);
    expect(rows).toHaveLength(11);
  });
});

describe("unicités par client (ADR 0040)", { timeout: 30_000 }, () => {
  const IDENTITE = "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL";
  const table = (nom: string, extra: string) => `CREATE TABLE ${SCHEMA}.${nom} (${IDENTITE}, nom_base text NOT NULL${extra});
    CREATE INDEX ${nom}_tenant ON ${SCHEMA}.${nom} (tenant_id);
    ALTER TABLE ${SCHEMA}.${nom} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${SCHEMA}.${nom} FORCE ROW LEVEL SECURITY;
    CREATE POLICY isolation ON ${SCHEMA}.${nom} USING (tenant_id = current_setting('app.tenant_id')::uuid);`;

  it("[A-163] @isolation sur bases_client, un index unique sur nom_base sans tenant_id est signalé par unicite_sans_tenant (schéma d'essai) ; l'index réel (tenant_id, nom_base) ne l'est pas", async () => {
    await migration.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    await migration.query(`${table("bases_ko", ", UNIQUE (nom_base)")} ${table("bases_ok", ", UNIQUE (tenant_id, nom_base)")}`);
    const ecarts = (await controlerInvariants(requete, "console", OPTIONS)).filter((e) => e.regle === "unicite_sans_tenant" && /(^|\.)(essai_t230\.bases_|bases_client)/.test(e.objet));
    expect(ecarts.map((e) => e.objet)).toEqual([`${SCHEMA}.bases_ko.bases_ko_nom_base_key`]);
    const reel = await migration.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'public.bases_client'::regclass AND contype = 'u'");
    expect(reel.rows.map((r) => r.d)).toContain("UNIQUE (tenant_id, nom_base)");
  });

  it("[A-163] @isolation un nom de base qui ne correspond pas au tenant_id de sa ligne est refusé par le CHECK", async () => {
    const A = await nouveauClient();
    const B = await nouveauClient();
    await expect(creerBase(A, { nom_base: nomDe(B) })).rejects.toMatchObject({ code: "23514" });
    await expect(creerBase(A, { nom_base: "cli_choisi_a_la_main" })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-163] @isolation le CHECK impose l'égalité nom_base = 'cli_' || replace(tenant_id::text, '-', '') : la valeur exacte est acceptée, une valeur d'un autre client, tronquée ou en majuscules est refusée, et le client A ne reçoit aucune erreur 23505 révélant le nom d'un autre client", async () => {
    const A = await nouveauClient();
    const B = await nouveauClient();
    const exact = nomDe(A);
    expect(exact).toMatch(/^cli_[0-9a-f]{32}$/);
    await creerBase(B);
    for (const mauvais of [nomDe(B), exact.slice(0, -1), exact.toUpperCase(), exact.replace("cli_", "cli_x"), `${exact} `]) {
      const erreur = await creerBase(A, { nom_base: mauvais }).catch((e: { code?: string }) => e);
      expect(erreur, mauvais).toMatchObject({ code: "23514" });
    }
    expect((await creerBase(A))["nom_base"]).toBe(exact);
    // Un second enregistrement du même client viole l'unicité (tenant_id, nom_base) : le client le sait déjà, il ne lit rien d'un autre.
    await expect(creerBase(A)).rejects.toMatchObject({ code: "23505" });
  });

  it("[A-163] @isolation propositions_suppression : l'unicité (tenant_id, fin_de_contrat_id, echeance) refuse la seconde proposition du même client et laisse passer la même échéance chez un autre client", async () => {
    const A = await nouveauClient();
    const B = await nouveauClient();
    const finA = await creerFin(A);
    const finB = await creerFin(B);
    await creerProposition(A, finA["id"]);
    await expect(creerProposition(A, finA["id"])).rejects.toMatchObject({ code: "23505" });
    await creerProposition(B, finB["id"]);
    await creerProposition(A, finA["id"], "2030-03-31");
  });

  it("[A-163] la liste EXCEPTIONS_UNICITE reste vide après la migration de T2-30", () => {
    expect(EXCEPTIONS_UNICITE).toEqual([{ table: "instances", index: "instances_id_unique", raison: "ADR 0111" }]);
  });
});

describe("fin de contrat et effacement (C-715)", { timeout: 40_000 }, () => {
  it("[C-715] @isolation portail_app n'a aucun droit sur reglages_fin_de_contrat, ni sur les quatre autres tables de la fin de vie ; un client A ne lit rien de B", async () => {
    // Le rôle portail_app n'existe pas dans la base console : aucun droit ne lui est accordé, PUBLIC est fermé, seuls console_app et console_equipe figurent.
    const { rows } = await migration.query(`
      SELECT c.relname, a.privilege_type, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS beneficiaire
      FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) AND a.grantee <> c.relowner ORDER BY 1, 3, 2`, [TABLES_FIN_DE_VIE]);
    const par: Record<string, Set<string>> = {};
    for (const r of rows) (par[`${r.relname}/${r.beneficiaire}`] ??= new Set()).add(r.privilege_type);
    expect(new Set(rows.map((r) => r.beneficiaire))).toEqual(new Set(["console_app", "console_equipe"]));
    for (const t of TABLES_FIN_DE_VIE) {
      expect([...(par[`${t}/console_equipe`] ?? [])], t).toEqual(["SELECT"]);
      const droits = [...(par[`${t}/console_app`] ?? [])];
      expect(droits, t).toContain("INSERT");
      expect(droits, t).not.toContain("DELETE");
      expect(droits, t).not.toContain("TRUNCATE");
    }
    expect((await migration.query("SELECT 1 FROM pg_roles WHERE rolname = 'portail_app'")).rowCount).toBe(0);
    const A = await nouveauClient();
    const B = await nouveauClient();
    await inserer(B, "reglages_fin_de_contrat", { organisation_id: B, delai_proposition_suppression_mois: 30, auteur: "agent-essai" });
    await ecrire(app, A, async (c) => {
      for (const t of TABLES_FIN_DE_VIE) expect((await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [B])).rows[0]?.n, t).toBe(0);
    }, APPELANT);
  });

  it("[C-715] la contrainte d'unicité (tenant_id, fin_de_contrat_id, echeance) refuse une seconde proposition pour la même échéance du même client, même si deux insertions partent en même temps", async () => {
    const A = await nouveauClient();
    const fin = await creerFin(A);
    const issues = await Promise.all(Array.from({ length: 6 }, () => creerProposition(A, fin["id"], "2031-01-31").then(() => "ok", (e: { code?: string }) => e.code)));
    expect(issues.filter((i) => i === "ok")).toHaveLength(1);
    expect(issues.filter((i) => i === "23505")).toHaveLength(5);
  });

  const decision = (A: string, valeurs: Record<string, unknown>) => inserer(A, "decisions_effacement", { decideur: randomUUID(), decision: "refuser", motif_ecrit: "motif d'essai", reauth_le: new Date().toISOString(), ...valeurs });
  async function demande(A: string) {
    return inserer(A, "demandes_effacement", { fin_de_contrat_id: (await creerFin(A))["id"], ecrit_reference: "objet-essai-001" });
  }

  it("[C-715] une décision `refuser` sans cause est rejetée ; une cause sans décision `refuser` est rejetée", async () => {
    const A = await nouveauClient();
    const d = (await demande(A))["id"];
    await expect(decision(A, { demande_id: d })).rejects.toMatchObject({ code: "23514" });
    await expect(decision(A, { demande_id: d, decision: "accepter", cause: "obligation_legale", reference_texte: "texte d'essai" })).rejects.toMatchObject({ code: "23514" });
    await expect(decision(A, { demande_id: d, decision: "accepter", motif_ecrit: "  " })).rejects.toMatchObject({ code: "23514" });
    await expect(decision(A, { decision: "accepter" })).rejects.toMatchObject({ code: "23514" });
    await expect(decision(A, { demande_id: d, cause: "decision_de_will" })).rejects.toMatchObject({ code: "23514" });
    await decision(A, { demande_id: d, decision: "accepter" });
  });

  it("[C-715] une décision `refuser` pour `litige_en_cours` sans `gel_id`, ou avec un gel levé, est rejetée", async () => {
    const A = await nouveauClient();
    const d = (await demande(A))["id"];
    await expect(decision(A, { demande_id: d, cause: "litige_en_cours" })).rejects.toMatchObject({ code: "23514" });
    const levé = await creerGel(A);
    await ecrire(app, A, (c) => c.query("UPDATE gels_litige SET levee_le = now(), leve_par = 'agent-essai' WHERE id = $1", [levé["id"]]), APPELANT);
    await expect(decision(A, { demande_id: d, cause: "litige_en_cours", gel_id: levé["id"] })).rejects.toMatchObject({ code: "23514" });
    const actif = await creerGel(A);
    expect(await decision(A, { demande_id: d, cause: "litige_en_cours", gel_id: actif["id"] })).toMatchObject({ cause: "litige_en_cours" });
    // Un gel d'un autre client n'est pas joignable.
    const B = await nouveauClient();
    await expect(decision(A, { demande_id: d, cause: "litige_en_cours", gel_id: (await creerGel(B))["id"] })).rejects.toThrow();
  });

  it("[C-715] une décision `refuser` pour `obligation_legale` sans `reference_texte` (vide ou espaces) est rejetée", async () => {
    const A = await nouveauClient();
    const d = (await demande(A))["id"];
    for (const vide of [undefined, "", "   "]) await expect(decision(A, { demande_id: d, cause: "obligation_legale", reference_texte: vide })).rejects.toMatchObject({ code: "23514" });
    expect(await decision(A, { demande_id: d, cause: "obligation_legale", reference_texte: "texte d'essai, article fictif" })).toMatchObject({ cause: "obligation_legale" });
  });

  it("[C-715] un délai inférieur à 2 est rejeté par la base ; la surcharge d'un client ne change pas celle d'un autre", async () => {
    const A = await nouveauClient();
    const B = await nouveauClient();
    for (const mauvais of [1, 0, -3]) await expect(inserer(A, "reglages_fin_de_contrat", { organisation_id: A, delai_proposition_suppression_mois: mauvais, auteur: "agent-essai" })).rejects.toMatchObject({ code: "23514" });
    await inserer(A, "reglages_fin_de_contrat", { organisation_id: A, delai_proposition_suppression_mois: 36, auteur: "agent-essai" });
    await inserer(B, "reglages_fin_de_contrat", { organisation_id: B, delai_proposition_suppression_mois: 2, auteur: "agent-essai" });
    const lire = (T: string) => ecrire(app, T, async (c) => (await c.query("SELECT delai_proposition_suppression_mois AS d FROM reglages_fin_de_contrat")).rows.map((r) => r.d));
    expect(await lire(A)).toEqual([36]);
    expect(await lire(B)).toEqual([2]);
  });

  it("[C-715] les décisions et les réglages sont en ajout seul (UPDATE et DELETE refusés)", async () => {
    const A = await nouveauClient();
    const d = (await demande(A))["id"];
    await decision(A, { demande_id: d, decision: "accepter" });
    await inserer(A, "reglages_fin_de_contrat", { organisation_id: A, delai_proposition_suppression_mois: 24, auteur: "agent-essai" });
    for (const t of ["decisions_effacement", "reglages_fin_de_contrat", "confirmations_mise_a_l_ecart", "attestations_fin_de_contrat"]) {
      await expect(ecrire(app, A, (c) => c.query(`UPDATE ${t} SET tenant_id = tenant_id`)), `UPDATE ${t}`).rejects.toMatchObject({ code: "42501" });
      await expect(ecrire(app, A, (c) => c.query(`DELETE FROM ${t}`)), `DELETE ${t}`).rejects.toMatchObject({ code: "42501" });
    }
    // Une demande ou une proposition ne se supprime jamais non plus.
    for (const t of ["demandes_effacement", "propositions_suppression"]) await expect(ecrire(app, A, (c) => c.query(`DELETE FROM ${t}`)), t).rejects.toMatchObject({ code: "42501" });
  });

  it("[C-715] chaque transition d'état d'une proposition autorisée est acceptée et chaque autre refusée (par exemple `executee`→`en_attente`, `en_attente`→`executee`, `ecartee`→`acceptee`)", async () => {
    const A = await nouveauClient();
    const fin = await creerFin(A);
    const AUTORISEES = [["en_attente", "acceptee"], ["en_attente", "ecartee"], ["ecartee", "reexamen"], ["acceptee", "executee"]];
    const ETATS = ["en_attente", "acceptee", "ecartee", "reexamen", "executee"];
    // Chemin pour atteindre chaque état de départ, par des transitions autorisées seulement.
    const CHEMIN: Record<string, string[]> = { en_attente: [], acceptee: ["acceptee"], ecartee: ["ecartee"], reexamen: ["ecartee", "reexamen"], executee: ["acceptee", "executee"] };
    let n = 0;
    for (const depuis of ETATS) {
      for (const vers of ETATS.filter((e) => e !== depuis)) {
        const p = await creerProposition(A, fin["id"], `2040-01-${String(++n).padStart(2, "0")}`);
        for (const etape of CHEMIN[depuis] ?? []) await ecrire(app, A, (c) => c.query("UPDATE propositions_suppression SET etat = $2 WHERE id = $1", [p["id"], etape]), APPELANT);
        const essai = ecrire(app, A, (c) => c.query("UPDATE propositions_suppression SET etat = $2 WHERE id = $1", [p["id"], vers]), APPELANT);
        if (AUTORISEES.some(([d, v]) => d === depuis && v === vers)) await expect(essai, `${depuis}→${vers}`).resolves.toBeDefined();
        else await expect(essai, `${depuis}→${vers}`).rejects.toMatchObject({ code: "23514" });
      }
    }
    // Les rappels et l'avis au client se mettent à jour sans changer d'état.
    const q = await creerProposition(A, fin["id"], "2041-01-01");
    await ecrire(app, A, (c) => c.query("UPDATE propositions_suppression SET rappels_envoyes = 1, avis_client_le = now() WHERE id = $1", [q["id"]]), APPELANT);
  }, 120_000);
  // Correctifs de relecture (PR n° 114) : les règles de droits tenues par la base.
  it("[C-715] un refus de demande d'effacement ne peut pas être « écarté » : `ecarter` vise une proposition, jamais une demande du client", async () => {
    const A = await nouveauClient();
    const d = (await demande(A))["id"];
    await expect(decision(A, { demande_id: d, decision: "ecarter", cause: "decision_de_will" })).rejects.toMatchObject({ code: "23514" });
    await expect(decision(A, { demande_id: d, decision: "ecarter", cause: "obligation_legale", reference_texte: "texte d'essai" })).rejects.toMatchObject({ code: "23514" });
    const fin = await creerFin(A);
    const prop = await creerProposition(A, fin["id"], "2032-06-30");
    expect(await decision(A, { proposition_id: prop["id"], decision: "ecarter", cause: "decision_de_will" })).toMatchObject({ cause: "decision_de_will" });
  });

  it("[C-715] une décision pour litige ne peut pas être antidatée pour s'appuyer sur un gel déjà levé", async () => {
    const A = await nouveauClient();
    const d = (await demande(A))["id"];
    const gel = await creerGel(A, { posee_le: "2020-01-01T00:00:00Z" });
    await ecrire(app, A, (c) => c.query("UPDATE gels_litige SET levee_le = now(), leve_par = 'agent-essai' WHERE id = $1", [gel["id"]]), APPELANT);
    await expect(decision(A, { demande_id: d, cause: "litige_en_cours", gel_id: gel["id"], decidee_le: "2020-06-01T00:00:00Z" })).rejects.toMatchObject({ code: "23514" });
  });

  it("[C-609] la levée d'un gel ne se réécrit pas : une seule fois, à la date du jour, sans retour en arrière", async () => {
    const A = await nouveauClient();
    const gel = await creerGel(A, { posee_le: "2020-01-01T00:00:00Z" });
    const maj = (sql: string) => ecrire(app, A, (c) => c.query(sql, [gel["id"]]), APPELANT);
    await expect(maj("UPDATE gels_litige SET levee_le = '2020-02-01T00:00:00Z', leve_par = 'agent-essai' WHERE id = $1")).rejects.toMatchObject({ code: "23514" });
    await maj("UPDATE gels_litige SET levee_le = now(), leve_par = 'agent-essai' WHERE id = $1");
    await expect(maj("UPDATE gels_litige SET levee_le = NULL, leve_par = NULL WHERE id = $1")).rejects.toMatchObject({ code: "23514" });
    await expect(maj("UPDATE gels_litige SET levee_le = levee_le - interval '1 day' WHERE id = $1")).rejects.toMatchObject({ code: "23514" });
    await expect(maj("UPDATE gels_litige SET leve_par = 'autre' WHERE id = $1")).rejects.toMatchObject({ code: "23514" });
  });

  it("[C-715] la mise à jour d'une demande ou d'une proposition se limite aux changements d'état prévus", async () => {
    const A = await nouveauClient();
    const dem = await demande(A);
    const maj = (sql: string, id: unknown) => ecrire(app, A, (c) => c.query(sql, [id]), APPELANT);
    await expect(maj("UPDATE demandes_effacement SET ecrit_reference = 'autre' WHERE id = $1", dem["id"])).rejects.toMatchObject({ code: "42501" });
    await expect(maj("UPDATE demandes_effacement SET recue_le = now() - interval '1 year' WHERE id = $1", dem["id"])).rejects.toMatchObject({ code: "42501" });
    await expect(maj("UPDATE demandes_effacement SET fin_de_contrat_id = gen_random_uuid() WHERE id = $1", dem["id"])).rejects.toMatchObject({ code: "42501" });
    await maj("UPDATE demandes_effacement SET etat = 'refusee' WHERE id = $1", dem["id"]);
    await maj("UPDATE demandes_effacement SET etat = 'en_attente' WHERE id = $1", dem["id"]);
    await maj("UPDATE demandes_effacement SET etat = 'acceptee' WHERE id = $1", dem["id"]);
    await expect(maj("UPDATE demandes_effacement SET etat = 'en_attente' WHERE id = $1", dem["id"])).rejects.toMatchObject({ code: "23514" });
    const prop = await creerProposition(A, dem["fin_de_contrat_id"], "2033-06-30");
    await expect(maj("UPDATE propositions_suppression SET cree_le = now() - interval '1 year' WHERE id = $1", prop["id"])).rejects.toMatchObject({ code: "42501" });
  });

  it("[C-567] la double confirmation exige deux personnes : la même personne ne confirme pas sous les deux rôles", async () => {
    const A = await nouveauClient();
    const fin = await creerFin(A);
    const personne = randomUUID();
    const confirmer = (confirmateur: string, role: string) => inserer(A, "confirmations_mise_a_l_ecart", { fin_de_contrat_id: fin["id"], confirmateur, role, reauth_le: new Date().toISOString() });
    await confirmer(personne, "will");
    await expect(confirmer(personne, "second_administrateur")).rejects.toMatchObject({ code: "23505" });
    await confirmer(randomUUID(), "second_administrateur");
  });
});
