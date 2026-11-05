import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { DOSSIER_CLI, lireEntrees, migrerBase, ouvrirConnexionModule, roleMigrationModule } from "../donnees/migrer-base.js";
import { sqlPg } from "./adaptateur-sql.js";
import { adminPg, nomBaseDe, nomsRoles } from "./etapes-base.js";
import { ecrireEchec, journalEchecs } from "./journal-echecs.js";
// Journal des échecs (CI) : le rapport JSON n'est pas publié ; la cause de chaque test rouge s'imprime ici, adresses de connexion masquées.
journalEchecs(import.meta.url);

// Étape 6 sur une grappe jetable (T235_PG_ADMIN_URL : adresse DIRECTE du rôle provisionneur, init.sql joué ; sans elle, calculée sur le socle : socket Unix de l'hôte posée par compose.zz-essai-donnees.yml). La base est créée par la vraie recette (adminPg) mais
// n'est PAS fermée : la fermeture retire au provisionneur le droit de prendre le rôle propriétaire (dette : T2-38 fixe qui lance les migrations après la fermeture).
const docker = (...a: string[]) => {
  try { return execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) {
    ecrireEchec("docker", a[0] ?? "", (e as { stderr?: string }).stderr ?? (e as Error).message, 300);
    throw e;
  }
};
const conteneurDonnees = () => {
  const id = docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=donnees");
  if (!id) throw new Error("conteneur donnees introuvable : le socle doit tourner (ops/socle/lancer.sh, fragment d'essai)");
  return id;
};
const adresseAdmin = () => {
  const mdp = docker("exec", conteneurDonnees(), "sh", "-c", 'printf %s/provisionneur "$SOCLE_PG_MOT_DE_PASSE" | sha256sum | cut -c1-64');
  return `postgresql://provisionneur:${mdp}@localhost/postgres?host=%2Ftmp%2Fsocle-donnees-socket`;
};
const ADMIN = process.env["T235_PG_ADMIN_URL"] ?? adresseAdmin();
const ESSAI = fileURLToPath(new URL("../../../../tests/modules/essai/migrations", import.meta.url));
const vers = (base: string) => { const u = new URL(ADMIN); u.pathname = `/${base}`; return u.toString(); };
const pools: pg.Pool[] = [];
const pool = (base: string) => { const p = new pg.Pool({ connectionString: vers(base), max: 1 }); p.on("error", () => undefined); pools.push(p); return p; };
afterAll(async () => { await Promise.all(pools.map((p) => p.end().catch(() => undefined))); });
// Sessions ouvertes sur une base (hors la session qui compte).
const connexionsSur = async (base: string) => Number((await pool("postgres").query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [base])).rows[0]?.n);
const fermerBase = async (_base: string): Promise<void> => undefined; // à écrire : ferme les pools de cette base
const empreinteVide = `SCRAM-SHA-256$4096:${randomBytes(16).toString("base64")}$${randomBytes(32).toString("base64")}:${randomBytes(32).toString("base64")}`;

async function clientNonFerme() {
  const id = randomUUID();
  const base = nomBaseDe(id);
  const admin = adminPg(sqlPg(pool("postgres")), (b) => sqlPg(pool(b)));
  await admin.creerBase(base, "modele_v1");
  let v = 0;
  for (const r of Object.values(nomsRoles(id))) await admin.poserRole(r, empreinteVide, ++v);
  const dans = pool(base);
  await dans.query(`GRANT ${nomsRoles(id).proprietaire} TO CURRENT_USER WITH SET TRUE`);
  // Comme après la fermeture : le propriétaire possède la base (il y crée donc le schéma du module).
  const p = nomsRoles(id).proprietaire;
  await pool("postgres").query(`ALTER DATABASE ${base} OWNER TO ${p}; SET ROLE ${p}; REVOKE ALL ON DATABASE ${base} FROM PUBLIC; GRANT CONNECT ON DATABASE ${base} TO provisionneur; RESET ROLE`);
  // modele_v1 (init.sql) est vide : les schémas commun et trace viennent des migrations du modèle, jouées par le propriétaire comme le fait la recette (étape 6).
  await migrerBase(base, lireEntrees(DOSSIER_CLI).length, { url: vers(base) });
  await dans.query(`SET ROLE ${p}`);
  return { id, base, dans, roles: nomsRoles(id) };
}
// Lit comme un rôle donné (le rôle de migration du module possède les tables du module ; le provisionneur ne le garde pas après la migration).
async function comme(c: { dans: pg.Pool }, role: string, sql: string, valeurs: unknown[] = []) {
  await c.dans.query("RESET ROLE");
  await c.dans.query(`GRANT ${role} TO CURRENT_USER WITH SET TRUE`).catch(() => undefined);
  await c.dans.query(`SET ROLE ${role}`);
  try { return (await c.dans.query(sql, valeurs)).rows; } finally { await c.dans.query("RESET ROLE"); }
}
const dossierAvec = (sql: string) => {
  const d = mkdtempSync(join(tmpdir(), "mod-"));
  mkdirSync(`${d}/meta`);
  writeFileSync(`${d}/0000_x.sql`, sql);
  writeFileSync(`${d}/meta/_journal.json`, JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1793612974019, tag: "0000_x", breakpoints: true }] }));
  return d;
};

// Un .int.test.ts ne tourne que sous SOCLE_INTEGRATION=1 : une grappe introuvable FAIT ÉCHOUER l'essai, jamais un saut silencieux.
describe("migrations d'un module (grappe jetable)", () => { // fiche: T2-35
  it("la grappe jetable répond (échec, pas saut)", async () => {
    expect((await pool("postgres").query("SELECT current_user AS u")).rows[0]?.u).toBe("provisionneur");
  }, 30_000);
  it("[A-219] les migrations du module d'essai sont appliquées dans a_<code>, par le rôle de migration du module, et rejouables", async () => {
    const c = await clientNonFerme();
    await migrerBase(c.base, 1, { url: vers(c.base), dossier: ESSAI, module: "essai" });
    await migrerBase(c.base, 1, { url: vers(c.base), dossier: ESSAI, module: "essai" });
    const m = roleMigrationModule(c.base, "essai");
    const t = await c.dans.query("SELECT tableowner FROM pg_tables WHERE schemaname = 'a_essai' AND tablename = 'essai_notes'");
    // Barrière de droits : les objets du module appartiennent au rôle de migration PROPRE au module, pas au propriétaire de la base.
    expect(t.rows[0]?.tableowner).toBe(m);
    expect(await comme(c, m, "SELECT version FROM a_essai.version_structure")).toEqual([{ version: 1 }]);
    expect((await c.dans.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'essai_notes' AND schemaname <> 'a_essai'")).rows[0]?.n).toBe(0);
    // L'application lit et écrit dans le schéma du module, sans DELETE.
    expect((await comme(c, c.roles.proprietaire, "SELECT has_table_privilege($1, 'a_essai.essai_notes', 'INSERT') AS i, has_table_privilege($1, 'a_essai.essai_notes', 'DELETE') AS d", [c.roles.app]))[0]).toEqual({ i: true, d: false });
  }, 60_000);

  // Fuite de connexions (53300 « too many clients » en CI) : après une migration de module et la fermeture des pools de l'essai, aucune session ne doit rester sur la base.
  it("[A-219] aucune connexion ne reste ouverte sur la base du client après une migration de module", async () => {
    const c = await clientNonFerme();
    await migrerBase(c.base, 1, { url: vers(c.base), dossier: ESSAI, module: "essai" });
    await fermerBase(c.base);
    expect(await connexionsSur(c.base)).toBe(0);
  }, 60_000);

  it("[A-219] @isolation le rôle de migration du module ne possède et n'écrit que a_<code> : rien dans commun ni public, même sans le filtre du texte", async () => {
    const c = await clientNonFerme();
    await migrerBase(c.base, 1, { url: vers(c.base), dossier: ESSAI, module: "essai" });
    const m = roleMigrationModule(c.base, "essai");
    const q = async (sql: string) => (await c.dans.query(sql)).rows[0] as Record<string, boolean>;
    expect(await q(`SELECT has_schema_privilege('${m}', 'commun', 'USAGE') AS u, has_schema_privilege('${m}', 'commun', 'CREATE') AS c, has_schema_privilege('${m}', 'public', 'CREATE') AS p`)).toEqual({ u: false, c: false, p: false });
    // Après la migration, le provisionneur ne reprend plus ce rôle par SET ROLE ; le texte du module, lui, ne s'exécute plus sur sa session mais sur la connexion du rôle du module (essais R1 ci-dessous).
    await c.dans.query("RESET ROLE");
    await expect(c.dans.query(`SET ROLE ${m}`)).rejects.toMatchObject({ code: "42501" });
    // Sous ce rôle, même les ordres que le filtre laisserait passer échouent hors du schéma du module.
    await c.dans.query(`GRANT ${m} TO CURRENT_USER WITH SET TRUE`);
    const k = new pg.Client({ connectionString: vers(c.base) });
    await k.connect();
    try {
      await k.query(`SET ROLE ${m}`);
      for (const sql of ["CREATE TABLE commun.vole (id int)", "CREATE TABLE public.vole (id int)", "DELETE FROM commun.personnes", "UPDATE commun.personnes SET nom = nom", "TRUNCATE commun.personnes", "ALTER TABLE commun.personnes DISABLE ROW LEVEL SECURITY", "INSERT INTO commun.exclusions DEFAULT VALUES"]) {
        await expect(k.query(sql), sql).rejects.toMatchObject({ code: "42501" });
      }
      await k.query("COMMIT").catch(() => undefined);
      await k.query("CREATE TABLE a_essai.autre (id int)");
    } finally { await k.end(); }
    // L'application ne touche pas au journal de versions du module.
    expect((await comme(c, c.roles.proprietaire, "SELECT has_table_privilege($1, 'a_essai.version_structure', 'SELECT') AS s", [c.roles.app]))[0]).toEqual({ s: false });
  }, 60_000);

  it("[A-219] @isolation une migration qui crée un objet hors a_<code> est refusée avant toute exécution, même masquée, et ne laisse rien", async () => {
    const c = await clientNonFerme();
    // Nom de schéma écrit en échappement Unicode : le texte ne le montre pas, le comptage des objets le voit.
    const d = dossierAvec('CREATE TABLE U&"\\0063ommun"."vole" (id int);');
    await expect(migrerBase(c.base, 1, { url: vers(c.base), dossier: d, module: "essai" })).rejects.toThrow(/refusées/);
    expect((await c.dans.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'vole'")).rows[0]?.n).toBe(0);
    expect((await c.dans.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'a_essai'")).rows[0]?.n).toBe(0);
  }, 60_000);
  // Charge R1 de l'audit, rejouée SANS le filtre du texte : elle s'exécute telle quelle sur la connexion du rôle du module (celle que migrerBase ouvre), seule barrière testée ici : les droits PostgreSQL.
  const chargeR1 = (reinit: string) => `SET search_path = a_essai; CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $f$ ${reinit}; ALTER ROLE ROLE_APP PASSWORD 'connu'; SELECT 1 $f$; CREATE TABLE t (x int DEFAULT f()); INSERT INTO t DEFAULT VALUES;`;
  const instantane = async (c: Awaited<ReturnType<typeof clientNonFerme>>) =>
    (await c.dans.query("SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil::text AS jusqua, (SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS membre_de FROM pg_roles r WHERE rolname LIKE $1 ORDER BY rolname", [`${c.base}\\_%`])).rows.filter((r) => !String(r.rolname).includes("_mod_"));
  async function rejouerR1(reinit: string) {
    const c = await clientNonFerme();
    const avant = await instantane(c);
    const admin = new pg.Client({ connectionString: vers(c.base) });
    await admin.connect();
    const mod = await ouvrirConnexionModule(admin, vers(c.base), c.base, "essai");
    try {
      const identite = (await mod.client.query("SELECT session_user AS s, current_user AS c")).rows[0];
      expect(identite).toEqual({ s: roleMigrationModule(c.base, "essai"), c: roleMigrationModule(c.base, "essai") });
      // F1 : le refus 42501 est celui de l'ALTER ROLE (message vérifié) ; le témoin positif ci-dessous prouve que la même charge SANS l'ALTER ROLE passe.
      await expect(mod.client.query(chargeR1(reinit).replace("ROLE_APP", c.roles.app))).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/alter role|permission denied/i) });
    } finally { await mod.fermer(); await admin.end(); }
    expect(await instantane(c)).toEqual(avant);
    // Le mot de passe « connu » n'ouvre rien : le rôle _app n'a pas changé de mot de passe.
    const u = new URL(vers(c.base)); u.username = c.roles.app; u.password = "connu";
    const k = new pg.Client({ connectionString: u.toString() });
    k.on("error", () => undefined);
    // F1 : refus d'authentification (28P01), pas une autre panne de connexion.
    await expect(k.connect()).rejects.toMatchObject({ code: "28P01" });
    await k.end().catch(() => undefined);
  }
  it("[A-219] @isolation témoin positif : la charge R1 SANS l'ALTER ROLE passe sur la connexion du rôle du module (le refus vient donc bien de l'ALTER ROLE)", async () => {
    const c = await clientNonFerme();
    const admin = new pg.Client({ connectionString: vers(c.base) });
    await admin.connect();
    const mod = await ouvrirConnexionModule(admin, vers(c.base), c.base, "essai");
    try {
      await expect(mod.client.query(chargeR1("SELECT 1").replace("ALTER ROLE ROLE_APP PASSWORD 'connu';", ""))).resolves.toBeTruthy();
    } finally { await mod.fermer(); await admin.end(); }
  }, 60_000);
  // F5 : mutation de preuve de A-219. Avec l'ancien SET ROLE sur la session du PROVISIONNEUR, la charge R1 réussit : l'essai R1 ci-dessus rougirait. Cet essai rejoue la mutation à chaque passage de la CI.
  it("[A-219] @isolation mutation de preuve : sous SET ROLE du propriétaire sur la session du provisionneur, la charge R1 réussit (l'essai R1 rougirait)", async () => {
    const c = await clientNonFerme();
    const admin = new pg.Client({ connectionString: vers(c.base) });
    await admin.connect();
    try {
      await admin.query(`GRANT ${c.roles.proprietaire} TO CURRENT_USER WITH SET TRUE`);
      await admin.query(`SET ROLE ${c.roles.proprietaire}`);
      await expect(admin.query(chargeR1("RESET ROLE").replace("ROLE_APP", c.roles.app).replace("SET search_path = a_essai;", "")), "la charge R1 aurait dû réussir sous l'ancien SET ROLE").resolves.toBeTruthy();
    } finally { await admin.query("RESET ROLE").catch(() => undefined); await admin.end(); }
  }, 60_000);
  it("[A-219] @isolation F3 : un droit TEMP ou CREATE du rôle du module sur la base fait refuser l'ouverture avant toute migration", async () => {
    const c = await clientNonFerme();
    await c.dans.query("RESET ROLE");
    await pool("postgres").query(`SET ROLE ${c.roles.proprietaire}; GRANT TEMPORARY ON DATABASE ${c.base} TO PUBLIC; RESET ROLE`);
    const admin = new pg.Client({ connectionString: vers(c.base) });
    await admin.connect();
    try {
      await expect(ouvrirConnexionModule(admin, vers(c.base), c.base, "essai")).rejects.toThrow(/hors de a_essai/);
      // Aucun rôle laissé LOGIN : le refus survient avant le ALTER ROLE … LOGIN.
      expect((await pool("postgres").query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [roleMigrationModule(c.base, "essai")])).rows[0]?.rolcanlogin).toBe(false);
    } finally { await admin.end(); }
  }, 60_000);
  it("[A-219] @isolation F2 : l'ALTER ROLE … LOGIN envoie une empreinte SCRAM, jamais le mot de passe en clair, et le rôle est NOLOGIN après la fermeture", async () => {
    const c = await clientNonFerme();
    const texte: string[] = [];
    const admin = new pg.Client({ connectionString: vers(c.base) });
    await admin.connect();
    const origine = admin.query.bind(admin) as (...a: unknown[]) => unknown;
    (admin as unknown as { query: unknown }).query = (...a: unknown[]) => { if (typeof a[0] === "string") texte.push(a[0]); return origine(...a); };
    const mod = await ouvrirConnexionModule(admin, vers(c.base), c.base, "essai");
    try {
      const alter = texte.find((t) => /ALTER ROLE .* LOGIN/.test(t));
      expect(alter).toMatch(/PASSWORD 'SCRAM-SHA-256\$4096:/);
    } finally { await mod.fermer(); await admin.end(); }
    expect((await pool("postgres").query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [roleMigrationModule(c.base, "essai")])).rows[0]?.rolcanlogin).toBe(false);
  }, 60_000);

  it("[A-219] @isolation la charge R1 (RESET ROLE caché dans une fonction) rejouée sans le filtre est refusée par PostgreSQL et ne change aucun rôle _app", async () => { await rejouerR1("RESET ROLE"); }, 60_000);
  it("[A-219] @isolation la variante RESET \"role\" de la charge R1 est refusée par PostgreSQL et ne change aucun rôle _app", async () => { await rejouerR1('RESET "role"'); }, 60_000);

  it("[A-219] @isolation un rôle _mod_ d'un autre client ne se connecte pas à la base du client, un rôle _mod_ NOLOGIN non plus", async () => {
    const a = await clientNonFerme();
    const b = await clientNonFerme();
    const admin = new pg.Client({ connectionString: vers(a.base) });
    await admin.connect();
    // Témoin : le rôle du module de A, ouvert par migrerBase, se connecte bien à la base de A (la règle pg_hba existe).
    const mod = await ouvrirConnexionModule(admin, vers(a.base), a.base, "essai");
    try { expect((await mod.client.query("SELECT current_user AS u")).rows[0]?.u).toBe(roleMigrationModule(a.base, "essai")); } finally { await mod.fermer(); await admin.end(); }
    // Un rôle _mod_ de B, LOGIN avec un mot de passe connu du test : atteint la base de A par pg_hba, mais PostgreSQL refuse le CONNECT.
    const etranger = roleMigrationModule(b.base, "essai");
    const mdp = randomBytes(24).toString("hex");
    await pool("postgres").query(`CREATE ROLE ${etranger} LOGIN NOINHERIT PASSWORD '${mdp}'`);
    const vers_ = (base: string, role: string, secret: string) => { const u = new URL(vers(base)); u.username = role; u.password = secret; return u.toString(); };
    try {
      const k = new pg.Client({ connectionString: vers_(a.base, etranger, mdp) });
      k.on("error", () => undefined);
      await expect(k.connect()).rejects.toMatchObject({ code: "42501" });
      await k.end().catch(() => undefined);
      // NOLOGIN et mot de passe NULL (état du rôle du module après toute migration) : aucune connexion, même vers sa propre base.
      await pool("postgres").query(`ALTER ROLE ${roleMigrationModule(a.base, "essai")} NOLOGIN PASSWORD NULL`);
      const n = new pg.Client({ connectionString: vers_(a.base, roleMigrationModule(a.base, "essai"), mdp) });
      n.on("error", () => undefined);
      await expect(n.connect()).rejects.toMatchObject({ code: expect.stringMatching(/^(28P01|28000)$/) });
      await n.end().catch(() => undefined);
    } finally { await pool("postgres").query(`ALTER ROLE ${etranger} NOLOGIN PASSWORD NULL`); }
  }, 90_000);

  it("[A-219] la règle pg_hba du rôle _mod_ est unique, locale (socket), en scram-sha-256, (base bornée par CONNECT), avant le refus par défaut", async () => {
    const mdp = 'PGPASSWORD=$(printf %s/donnees-postgres "$SOCLE_PG_MOT_DE_PASSE" | sha256sum | cut -c1-64)';
    const requete = "SELECT rule_number || '|' || type || '|' || database::text || '|' || user_name::text || '|' || auth_method FROM pg_hba_file_rules WHERE error IS NULL ORDER BY rule_number";
    const lignes = docker("exec", conteneurDonnees(), "sh", "-c", `${mdp} psql -w -U postgres -d postgres -tAXc "${requete}"`).split("\n").map((l) => l.replaceAll('"', ""));
    const mods = lignes.filter((l) => l.includes("_mod_"));
    expect(mods.map((l) => l.split("|").slice(1).join("|"))).toEqual(["local|{all}|{/^cli_[0-9a-f]{12}_mod_[a-z][a-z0-9_]*$}|scram-sha-256"]);
    const numero = (l: string | undefined) => Number(l?.split("|")[0]);
    const refusLocal = lignes.find((l) => l.split("|").slice(1).join("|") === "local|{all}|{all}|reject");
    expect(numero(mods[0])).toBeLessThan(numero(refusLocal));
    expect(lignes.filter((l) => l.split("|")[1] === "host" && l.includes("_mod_"))).toEqual([]);
  }, 60_000);
});
