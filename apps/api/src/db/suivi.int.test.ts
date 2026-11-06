import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, EXCEPTIONS_UNICITE, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Tables de suivi (T2-07) : notes, demandes (métadonnées), cellules, thèmes, outils, audits, besoins, propositions, registre des traitements. Socle lancé par ops/socle/lancer.sh (job socle-integration).
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

// Les écritures auditées passent par le verrou du journal : une attente trop longue (55P03) ou un interblocage (40P01) est rejoué.
async function ecrire<T>(...args: Parameters<typeof avecClient<T>>): Promise<T> {
  for (let essai = 1; ; essai++) {
    try {
      return await avecClient(...args);
    } catch (e) {
      // 55P03 : attente du verrou du journal ; 40P01 : interblocage entre ce verrou et un verrou de ligne. PostgreSQL en tue un, l'appelant rejoue.
      if (!["55P03", "40P01"].includes((e as { code?: string }).code ?? "") || essai >= 6) throw e;
    }
  }
}
// Instance d'un client : colonnes explicites, jamais RETURNING * (C-676, console_app ne lit plus toutes les colonnes d'instances).
const inserer = (tenant: string, table: string, valeurs: Record<string, unknown>, appelant: typeof APPELANT | null = APPELANT) => {
  const v = { id: randomUUID(), tenant_id: tenant, ...valeurs };
  const cles = Object.keys(v);
  return ecrire(app, tenant, async (c) => (await c.query(`INSERT INTO ${table} (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${table === "instances" ? "tenant_id, id" : "*"}`, Object.values(v))).rows[0] as Record<string, unknown>, appelant ?? undefined);
};
const creerOrg = (id: string) => inserer(id, "organisations", { id, console_client_id: id, raison_sociale: "Atelier Bertin" });
// À l'état pause : l'activation exige un contrat de sous-traitance (T2-05). Seul l'identifiant revient (colonnes lisibles d'instances, C-676).
const creerInstance = (A: string) =>
  ecrire(app, A, async (c) => (await c.query("INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $1, 'relance-devis', 'abonnement', 'test', 'pause') RETURNING id", [A])).rows[0] as Record<string, unknown>, APPELANT);
const REF = () => `demande:${randomUUID()}`;
const note = (A: string, extra: Record<string, unknown> = {}, appelant: typeof APPELANT | null = APPELANT) =>
  inserer(A, "notes", { organisation_id: A, auteur: "agent-essai", texte: "Appel de suivi, rappeler jeudi.", type: "appel", ...extra }, appelant);
const demande = (A: string, extra: Record<string, unknown> = {}, appelant: typeof APPELANT | null = APPELANT) =>
  inserer(A, "demandes", { organisation_id: A, canal: "courriel", categorie: "question", priorite: "normale", reference_texte: REF(), ...extra }, appelant);
const maj = (A: string, texte: string, valeurs: unknown[], appelant: typeof APPELANT | null = APPELANT) => ecrire(app, A, (c) => c.query(texte, valeurs), appelant ?? undefined);
const unique = () => randomUUID().replaceAll("-", "").slice(0, 8);
// Écriture de l'équipe sur une table commune : une transaction avec l'acteur du journal (rejouée sur 55P03 / 40P01).
async function ecrireEquipe<T>(fn: (c: pg.PoolClient) => Promise<T>, acteur: string | null = "agent-essai"): Promise<T> {
  for (let essai = 1; ; essai++) {
    const c = await equipe.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.acteur', $1, true), set_config('lock_timeout', '5s', true)", [acteur ?? ""]);
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
// Automatisation de catalogue (table commune, écrite par l'équipe sous un acteur : le rôle de migration n'a aucune politique d'écriture).
const creerAutomatisation = async () =>
  (await ecrireEquipe((c) => c.query("INSERT INTO automatisations (code, nom) VALUES ($1, 'Relance de devis') RETURNING id", [`ESS-${String(Math.floor(Math.random() * 90000) + 10000)}`]))).rows[0]?.["id"] as string;
const cellule = (extra: Record<string, unknown> = {}) => {
  const v = { code: `cellule-${unique()}`, adresse_interne: `cellule-${unique()}.interne.test`, mode: "mutualise", capacite: 50, nombre_instances: 3, version_image: "1.0.0", etat: "active", ...extra };
  const cles = Object.keys(v);
  return ecrireEquipe((c) => c.query(`INSERT INTO cellules (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id, code`, Object.values(v)));
};

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

// Le rapport de la CI est un JSON hors du journal : un essai en échec est écrit par writeSync(2, …), lisible dans le journal du job.
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

describe("suivi, avec le socle", { timeout: 90_000 }, () => {
  it("[A-132] une note garde auteur, texte, type et date ; l'auteur est l'appelant ; elle ne se modifie ni ne se supprime", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const n = await note(A);
    expect(n).toMatchObject({ auteur: "agent-essai", type: "appel", organisation_id: A });
    expect(n["cree_le"]).toBeTruthy();
    await expect(note(A, { auteur: "autre-agent" })).rejects.toMatchObject({ code: "42501" });
    await expect(note(A, {}, null)).rejects.toMatchObject({ code: "42501" });
    await expect(note(A, { texte: "x".repeat(1001) })).rejects.toMatchObject({ code: "23514" });
    await expect(note(A, { texte: "   " })).rejects.toMatchObject({ code: "23514" });
    await expect(note(A, { type: "message" })).rejects.toMatchObject({ code: "22P02" });
    await expect(maj(A, "UPDATE notes SET texte = 'autre' WHERE id = $1", [n["id"]])).rejects.toMatchObject({ code: "42501" });
    await expect(maj(A, "DELETE FROM notes WHERE id = $1", [n["id"]])).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query("TRUNCATE notes"), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-136] une demande garde organisation, automatisation, canal, catégorie, priorité, statut, responsable ; elle naît nouvelle ; close est définitif", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const d = await demande(A, { responsable: "agent-essai" });
    expect(d).toMatchObject({ canal: "courriel", categorie: "question", priorite: "normale", statut: "nouvelle", responsable: "agent-essai", automatisation_id: null });
    await expect(demande(A, { statut: "close" })).rejects.toMatchObject({ code: "42501" });
    await expect(demande(A, {}, null)).rejects.toMatchObject({ code: "42501" });
    await maj(A, "UPDATE demandes SET statut = 'en_cours', responsable = 'autre-agent' WHERE id = $1", [d["id"]]);
    await maj(A, "UPDATE demandes SET statut = 'close' WHERE id = $1", [d["id"]]);
    expect((await maj(A, "UPDATE demandes SET statut = 'en_cours' WHERE id = $1", [d["id"]])).rowCount).toBe(0);
    await expect(maj(A, "UPDATE demandes SET reference_texte = $2 WHERE id = $1", [d["id"], REF()])).rejects.toMatchObject({ code: "42501" });
    // Sans appelant : refusé par la politique d'acteur (sur une demande encore ouverte, car une demande close n'est déjà plus visible pour la mise à jour).
    const ouverte = await demande(A);
    await expect(maj(A, "UPDATE demandes SET statut = 'en_attente' WHERE id = $1", [ouverte["id"]], null)).rejects.toMatchObject({ code: "42501" });
    await expect(maj(A, "DELETE FROM demandes WHERE id = $1", [d["id"]])).rejects.toMatchObject({ code: "42501" });
    await expect(demande(A, { automatisation_id: randomUUID() })).rejects.toMatchObject({ code: "23503" });
  });

  it("[C-034] une demande ne garde que la référence du texte (un pointeur vers la base du client) : un texte libre est refusé", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await expect(demande(A, { reference_texte: "Bonjour, je voudrais savoir où en est ma facture" })).rejects.toMatchObject({ code: "23514" });
    await expect(demande(A, { reference_texte: `demande:${randomUUID()} et la suite du message` })).rejects.toMatchObject({ code: "23514" });
    await expect(demande(A, { categorie: "Une phrase entière avec des espaces" })).rejects.toMatchObject({ code: "23514" });
    await expect(demande(A, { responsable: "x".repeat(201) })).rejects.toMatchObject({ code: "23514" });
    const ref = REF();
    await demande(A, { reference_texte: ref });
    await expect(demande(A, { reference_texte: ref })).rejects.toMatchObject({ code: "23505" });
    const { rows } = await migration.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'demandes' AND data_type IN ('json', 'jsonb', 'bytea') OR (table_name = 'demandes' AND data_type = 'ARRAY')");
    expect(rows).toEqual([]);
  });

  it("[A-119] @isolation console_app du client A ne lit aucune note, demande, thème, outil, audit, besoin ni proposition de B, et n'en écrit aucune pour B", async () => {
    const [A, B] = [randomUUID(), randomUUID()];
    await creerOrg(A);
    await creerOrg(B);
    await note(B);
    await demande(B);
    await inserer(B, "themes_client", { organisation_id: B, couleur_principale: "couleur.action", couleur_accent: "couleur.teinte.vert.liseret", police: "police.titre", ton: "formel", actif: false });
    await inserer(B, "outils_client", { organisation_id: B, famille: "messagerie", outil: "microsoft365" });
    const auditB = await inserer(B, "audits_client", { organisation_id: B, type: "decouverte", date_audit: "2026-10-15", identifiant_hub: `audit-${unique()}` });
    await inserer(B, "besoins", { audit_id: auditB["id"], categorie: "relance_devis", priorite: "haute", minutes_perdues_estimees: 60 });
    const propB = await inserer(B, "propositions", { organisation_id: B, audit_id: auditB["id"], statut: "brouillon", identifiant_hub: `prop-${unique()}`, nombre_paliers: 2 });
    const autoB = await creerAutomatisation();
    await inserer(B, "propositions_automatisations", { proposition_id: propB["id"], automatisation_id: autoB, palier: 1 });
    for (const table of ["notes", "demandes", "themes_client", "outils_client", "audits_client", "besoins", "propositions", "propositions_automatisations"]) {
      expect((await ecrire(app, A, (c) => c.query(`SELECT count(*)::int AS n FROM ${table}`))).rows[0]?.n, table).toBe(0);
    }
    await expect(inserer(A, "notes", { organisation_id: B, auteur: "agent-essai", texte: "x", type: "appel", tenant_id: B })).rejects.toMatchObject({ code: "42501" });
    await expect(inserer(A, "demandes", { organisation_id: B, canal: "courriel", categorie: "question", priorite: "normale", reference_texte: REF() })).rejects.toMatchObject({ code: "23503" });
    expect((await ecrire(app, B, (c) => c.query("SELECT count(*)::int AS n FROM notes"))).rows[0]?.n).toBe(1);
    expect((await ecrire(app, A, (c) => c.query("UPDATE demandes SET statut = 'en_cours' WHERE tenant_id = $1", [B]), APPELANT)).rowCount).toBe(0);
  });

  it("[A-134] une cellule garde adresse, mode, capacité, nombre d'instances, version d'image, dernier signal de vie et état ; console_app ne la lit pas ; l'équipe l'écrit sous un acteur", async () => {
    const c = await cellule();
    const { rows } = await equipe.query("SELECT adresse_interne, mode, capacite, nombre_instances, version_image, dernier_signal_le, etat FROM cellules WHERE id = $1", [c.rows[0]?.["id"]]);
    expect(rows[0]).toMatchObject({ mode: "mutualise", capacite: 50, nombre_instances: 3, version_image: "1.0.0", dernier_signal_le: null, etat: "active" });
    expect(String(rows[0]?.["adresse_interne"])).toMatch(/\.interne\.test$/);
    await ecrireEquipe((x) => x.query("UPDATE cellules SET dernier_signal_le = now(), nombre_instances = 4 WHERE id = $1", [c.rows[0]?.["id"]]));
    await expect(cellule({ capacite: 0 })).rejects.toMatchObject({ code: "23514" });
    await expect(cellule({ nombre_instances: -1 })).rejects.toMatchObject({ code: "23514" });
    await expect(cellule({ mode: "dedie_ou_pas" })).rejects.toMatchObject({ code: "22P02" });
    await expect(cellule({ adresse_interne: "10.0.0 .1 espace" })).rejects.toMatchObject({ code: "23514" });
    await expect(ecrire(app, randomUUID(), (x) => x.query("SELECT adresse_interne FROM cellules"))).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, randomUUID(), (x) => x.query("INSERT INTO cellules (code, adresse_interne, mode, capacite, version_image) VALUES ('x', 'x.test', 'mutualise', 1, '1.0.0')"), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(ecrireEquipe((x) => x.query("DELETE FROM cellules WHERE id = $1", [c.rows[0]?.["id"]]))).rejects.toMatchObject({ code: "42501" });
    await expect(cellule({}).then(() => ecrireEquipe((x) => x.query("INSERT INTO cellules (code, adresse_interne, mode, capacite, version_image) VALUES ($1, 'y.test', 'mutualise', 1, '1.0.0')", [`c-${unique()}`]), null))).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-138] un client sans thème actif n'a aucune ligne (le thème AXION s'applique) ; un seul thème actif par client ; l'actif est lisible par le seul client", async () => {
    const [A, B] = [randomUUID(), randomUUID()];
    await creerOrg(A);
    await creerOrg(B);
    expect((await ecrire(app, A, (c) => c.query("SELECT count(*)::int AS n FROM themes_client WHERE actif"))).rows[0]?.n).toBe(0);
    const theme = (T: string, extra: Record<string, unknown> = {}) =>
      inserer(T, "themes_client", { organisation_id: T, logo_ref: "logos/lemoine-renovation.png", couleur_principale: "couleur.action", couleur_accent: "couleur.teinte.vert.liseret", police: "police.titre", ton: "formel", signature: "L'équipe Lemoine Rénovation", mentions_legales: "Mentions de l'atelier.", actif: false, ...extra });
    const t1 = await theme(A);
    await theme(B, { actif: true });
    await maj(A, "UPDATE themes_client SET actif = true WHERE id = $1", [t1["id"]]);
    const t2 = await theme(A);
    await expect(maj(A, "UPDATE themes_client SET actif = true WHERE id = $1", [t2["id"]])).rejects.toMatchObject({ code: "23505" });
    await expect(theme(A, { couleur_principale: "#12ab34" })).rejects.toMatchObject({ code: "23514" });
    await expect(theme(A, { logo_ref: "../secret" })).rejects.toMatchObject({ code: "23514" });
    await expect(maj(A, "DELETE FROM themes_client WHERE id = $1", [t1["id"]])).rejects.toMatchObject({ code: "42501" });
    expect((await ecrire(app, A, (c) => c.query("SELECT count(*)::int AS n FROM themes_client WHERE actif"))).rows[0]?.n).toBe(1);
  });

  it("[A-140] un outil du client dit si un connecteur existe ; un même outil n'est déclaré qu'une fois par organisation", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const o = await inserer(A, "outils_client", { organisation_id: A, famille: "messagerie", outil: "microsoft365", connecteur_disponible: true });
    expect(o).toMatchObject({ famille: "messagerie", outil: "microsoft365", connecteur_disponible: true });
    await expect(inserer(A, "outils_client", { organisation_id: A, famille: "messagerie", outil: "microsoft365" })).rejects.toMatchObject({ code: "23505" });
    await expect(inserer(A, "outils_client", { organisation_id: A, famille: "inconnue", outil: "autre" })).rejects.toMatchObject({ code: "22P02" });
    const sans = await inserer(A, "outils_client", { organisation_id: A, famille: "crm", outil: "outil-maison" });
    expect(sans["connecteur_disponible"]).toBe(false);
    await maj(A, "UPDATE outils_client SET connecteur_disponible = true WHERE id = $1", [sans["id"]]);
  });

  it("[A-151] [A-152] [A-153] un audit garde type, date et identifiant axion-ia.com ; un besoin, priorité et minutes perdues ; une proposition, automatisations, paliers et statut", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const audit = await inserer(A, "audits_client", { organisation_id: A, type: "decouverte", date_audit: "2026-10-15", identifiant_hub: `audit-${unique()}` });
    expect(audit).toMatchObject({ type: "decouverte", compte_rendu_ref: null });
    await expect(inserer(A, "audits_client", { organisation_id: A, type: "decouverte", date_audit: "2026-10-15", identifiant_hub: audit["identifiant_hub"] })).rejects.toMatchObject({ code: "23505" });
    const besoin = await inserer(A, "besoins", { audit_id: audit["id"], categorie: "relance_devis", priorite: "haute", minutes_perdues_estimees: 240 });
    expect(besoin).toMatchObject({ priorite: "haute", minutes_perdues_estimees: 240, automatisation_id: null });
    await expect(inserer(A, "besoins", { audit_id: audit["id"], categorie: "relance_devis", priorite: "haute", minutes_perdues_estimees: -1 })).rejects.toMatchObject({ code: "23514" });
    await expect(inserer(A, "besoins", { audit_id: randomUUID(), categorie: "relance_devis", priorite: "haute", minutes_perdues_estimees: 1 })).rejects.toMatchObject({ code: "23503" });
    const proposition = await inserer(A, "propositions", { organisation_id: A, audit_id: audit["id"], statut: "brouillon", identifiant_hub: `prop-${unique()}`, nombre_paliers: 3 });
    expect(proposition).toMatchObject({ statut: "brouillon", nombre_paliers: 3 });
    await expect(inserer(A, "propositions", { organisation_id: A, statut: "brouillon", identifiant_hub: proposition["identifiant_hub"], nombre_paliers: 1 })).rejects.toMatchObject({ code: "23505" });
    await expect(inserer(A, "propositions", { organisation_id: A, statut: "brouillon", identifiant_hub: `p-${unique()}`, nombre_paliers: 0 })).rejects.toMatchObject({ code: "23514" });
    await expect(inserer(A, "propositions_automatisations", { proposition_id: proposition["id"], automatisation_id: randomUUID(), palier: 1 })).rejects.toMatchObject({ code: "23503" });
    await expect(inserer(A, "propositions_automatisations", { proposition_id: randomUUID(), automatisation_id: randomUUID(), palier: 1 })).rejects.toMatchObject({ code: "23503" });
    const auto = await creerAutomatisation();
    const liaison = await inserer(A, "propositions_automatisations", { proposition_id: proposition["id"], automatisation_id: auto, palier: 2 });
    expect(liaison).toMatchObject({ proposition_id: proposition["id"], automatisation_id: auto, palier: 2 });
    const relues = await ecrire(app, A, (c) => c.query("SELECT automatisation_id, palier FROM propositions_automatisations WHERE proposition_id = $1", [proposition["id"]]));
    expect(relues.rows).toEqual([{ automatisation_id: auto, palier: 2 }]);
    await expect(inserer(A, "propositions_automatisations", { proposition_id: proposition["id"], automatisation_id: await creerAutomatisation(), palier: 6 })).rejects.toMatchObject({ code: "23514" });
    await expect(maj(A, "UPDATE propositions_automatisations SET palier = 3 WHERE id = $1", [liaison["id"]])).rejects.toMatchObject({ code: "42501" });
    const avecAuto = await demande(A, { automatisation_id: auto });
    expect(avecAuto).toMatchObject({ automatisation_id: auto });
    await expect(demande(A, { automatisation_id: randomUUID() })).rejects.toMatchObject({ code: "23503" });
    await maj(A, "UPDATE propositions SET statut = 'envoyee' WHERE id = $1", [proposition["id"]]);
    await expect(maj(A, "UPDATE propositions SET identifiant_hub = 'autre' WHERE id = $1", [proposition["id"]])).rejects.toMatchObject({ code: "42501" });
    await expect(maj(A, "DELETE FROM propositions WHERE id = $1", [proposition["id"]])).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-200] le registre des traitements existe dans la base console, lisible par l'équipe seule ; chaque ligne garde finalité, base légale, catégories, destinataires, durée, mesures", async () => {
    const v = { code: `traitement-${unique()}`, finalite: "Suivi des automatisations du client", base_legale: "contrat", categories_donnees: "Identité professionnelle, métadonnées d'exécution", destinataires: "Équipe AXION IA", duree_conservation: "24 mois après la fin du contrat, puis proposition de suppression (jamais automatique)", mesures_securite: "Chiffrement, isolation par client, journal d'audit (IP en HMAC)" };
    const cles = Object.keys(v);
    const r = await ecrireEquipe((c) => c.query(`INSERT INTO registre_traitements (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, Object.values(v)));
    expect((await equipe.query("SELECT finalite, base_legale FROM registre_traitements WHERE id = $1", [r.rows[0]?.["id"]])).rows[0]).toMatchObject({ base_legale: "contrat" });
    await expect(ecrire(app, randomUUID(), (c) => c.query("SELECT finalite FROM registre_traitements"))).rejects.toMatchObject({ code: "42501" });
    await expect(ecrireEquipe((c) => c.query(`INSERT INTO registre_traitements (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values({ ...v, base_legale: "bon_vouloir" })))).rejects.toMatchObject({ code: "22P02" });
    await expect(ecrireEquipe((c) => c.query("DELETE FROM registre_traitements WHERE id = $1", [r.rows[0]?.["id"]]))).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-119] colonnes d'instances : console_app ne lit toujours pas les colonnes d'origine, et les nouvelles tables n'en dépendent pas", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await creerInstance(A);
    await expect(ecrire(app, A, (c) => c.query("SELECT * FROM instances"))).rejects.toMatchObject({ code: "42501" });
    expect((await ecrire(app, A, (c) => c.query("SELECT id FROM instances"))).rows).toHaveLength(1);
  });

  it("[A-119] invariants C5 sans écart après la migration de T2-07 (tables communes comprises), et la liste EXCEPTIONS_UNICITE reste vide", async () => {
    const ecarts = (await controlerInvariants(requete, "console", OPTIONS)).filter((e) => !/(^|\.)essai_/.test(e.objet) && !e.objet.startsWith("partman."));
    expect(ecarts).toEqual([]);
    const { rows } = await migration.query("SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY 1", [["audits_client", "besoins", "cellules", "demandes", "notes", "outils_client", "propositions", "propositions_automatisations", "registre_traitements", "themes_client"]]);
    expect(rows).toHaveLength(10);
    expect(EXCEPTIONS_UNICITE).toEqual([]);
  });
});
