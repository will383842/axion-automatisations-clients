import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../scripts/garde-compose.ts";

// T2-31 : grappe PostgreSQL « données », son PgBouncer, une base par client (ADR 0046). Tests contre le socle lancé par ops/socle/lancer.sh (job socle-integration).
// Tout se passe dans des conteneurs jetables. Mots de passe : générés ici, préfixe TEST-NE-PAS-UTILISER-, jamais écrits dans un fichier.
const racine = (chemin: string) => fileURLToPath(new URL(`../../${chemin}`, import.meta.url));
const lire = (chemin: string) => readFileSync(racine(chemin), "utf8");
interface ClientPg {
  connect(): Promise<void>;
  query(texte: string): Promise<{ rows: { v?: unknown }[] }>;
  end(): Promise<void>;
  on(evenement: "error", ecouteur: () => void): unknown;
}
// Le pilote pg est une dépendance de apps/api : on le charge depuis là.
const { Client } = createRequire(racine("apps/api/package.json"))("pg") as { Client: new (options: Record<string, unknown>) => ClientPg };
const PROJET = "socle";
const mdp = () => `TEST-NE-PAS-UTILISER-${randomBytes(12).toString("hex")}`;
const A = "0a0a0a0a0a0a";
const B = "0b0b0b0b0b0b";
const P4 = "aaaaaaaaaaa4";
const P8 = "aaaaaaaaaaa8";
const MDP: Record<string, string> = {};
const mdpDe = (role: string) => (MDP[role] ??= mdp());
const bases = (n: number) => Array.from({ length: n }, (_, i) => `c${(i + 1).toString(16).padStart(11, "0")}`);

const executer = (cmd: string, args: string[], input?: string) => spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
const conteneur = (service: string) =>
  executer("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${PROJET}`, "--filter", `label=com.docker.compose.service=${service}`]).stdout.trim();
const adresse = (service: string) => executer("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", conteneur(service)]).stdout.trim();
// psql dans le conteneur d'un service ; « hote » vise PgBouncer ou le serveur par le réseau interne.
const psql = (service: string, utilisateur: string, base: string, requete: string, opts: { hote?: string; port?: string; motDePasse?: string } = {}) => {
  const env = opts.motDePasse ? ["-e", `PGPASSWORD=${opts.motDePasse}`] : [];
  const hote = opts.hote ? ["-h", opts.hote, "-p", opts.port ?? "5432"] : [];
  const r = executer("docker", ["exec", "-i", ...env, conteneur(service), "psql", ...hote, "-U", utilisateur, "-d", base, "-tAXc", requete]);
  return { ok: r.status === 0, sortie: r.stdout.trim(), erreur: r.stderr.trim() };
};
const superu = (base: string, requete: string) => psql("donnees", "postgres", base, requete);
const commune = (requete: string) => psql("postgres", "postgres", "postgres", requete);
const direct = (role: string, base: string, requete: string) => psql("donnees", role, base, requete, { hote: "127.0.0.1", motDePasse: mdpDe(role) });
const parPgBouncer = (role: string, base: string, requete: string) => psql("donnees", role, base, requete, { hote: "pgbouncer-donnees", port: "6432", motDePasse: mdpDe(role) });
const role = (id: string, nom: "proprietaire" | "app" | "lecture") => `cli_${id}_${nom}`;

// Recette de création : connexion directe du provisionneur (socket du conteneur), jamais PgBouncer.
const creer = (id: string, extra: string[] = []) => {
  const env = ["CLI_MDP_APP", "CLI_MDP_LECTURE"].flatMap((v) => ["-e", `${v}=${mdpDe(role(id, v === "CLI_MDP_APP" ? "app" : "lecture"))}`]);
  const r = executer("docker", ["exec", "-i", ...env, conteneur("donnees"), "psql", "-U", "provisionneur", "-d", "postgres", "-X", "-q", "-v", `id=${id}`, ...extra, "-f", "/docker-entrypoint-initdb.d/creer-base.sql"]);
  if (r.status !== 0) throw new Error(`creer-base ${id} : ${r.stderr}`);
};
const creerPlusieurs = (ids: string[]) => {
  const script = `for id in ${ids.join(" ")}; do psql -U provisionneur -d postgres -X -q -v id=$id -f /docker-entrypoint-initdb.d/creer-base.sql || exit 1; done`;
  const env = ["CLI_MDP_APP=TEST-NE-PAS-UTILISER-charge-app", "CLI_MDP_LECTURE=TEST-NE-PAS-UTILISER-charge-lecture"].flatMap((v) => ["-e", v]);
  const r = executer("docker", ["exec", ...env, conteneur("donnees"), "sh", "-c", script]);
  if (r.status !== 0) throw new Error(`creation en série : ${r.stderr}`);
};
// Une connexion coupée par le serveur après coup émet « error » : sans écouteur, Vitest la compte comme erreur non gérée.
const clientPg = (hote: string, port: number, utilisateur: string, base: string, motDePasse: string): ClientPg => {
  const c = new Client({ host: hote, port, user: utilisateur, database: base, password: motDePasse, connectionTimeoutMillis: 25_000 });
  c.on("error", () => undefined);
  return c;
};
const attendre = async (condition: () => boolean, secondes: number) => {
  for (let i = 0; i < secondes; i++) {
    if (condition()) return true;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return condition();
};
const toutesLesConnexions = () => Number(superu("postgres", "select count(*) from pg_stat_activity where usename like 'cli\\_%'").sortie);
const serveurs = (base: string) => Number(superu("postgres", `select count(*) from pg_stat_activity where datname='cli_${base}' and usename like 'cli\\_%'`).sortie);

// Le job ne montre pas le rapport JSON : chaque échec va sur la sortie d'erreur.
afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") writeSync(2, `ECHEC ${ctx.task.name}\n${(ctx.task.result.errors ?? []).map((e) => e.message).join("\n")}\n`);
});

beforeAll(() => {
  creer(A);
  creer(B);
  // Paliers 4 et 8 : la limite de connexions du rôle ne doit pas être plus basse que le palier de PgBouncer.
  creer(P4, ["-v", "limite_app=10"]);
  creer(P8, ["-v", "limite_app=10"]);
  // Une table de A, créée par son propriétaire (le superutilisateur d'essai prend le rôle), avec une ligne repérable.
  for (const [id, m] of [[A, "MARQUEUR-A"], [B, "MARQUEUR-B"]] as const)
    superu(`cli_${id}`, `set role ${role(id, "proprietaire")}; create table essai(note text); insert into essai values ('${m}-${randomBytes(6).toString("hex")}')`);
}, 240_000);

describe("grappe données (A-050, A-199, A-167)", () => {
  it("[A-050] la grappe données est distincte de la grappe commune : console n'y existe pas, cli_ n'existe pas dans la commune", () => {
    const dansDonnees = superu("postgres", "select datname from pg_database order by 1").sortie.split("\n");
    for (const interdite of ["console", "moteur", "keycloak", "passerelle_ia"]) expect(dansDonnees).not.toContain(interdite);
    expect(dansDonnees).toContain(`cli_${A}`);
    expect(commune("select count(*) from pg_database where datname like 'cli\\_%'").sortie).toBe("0");
    const compose = lireYaml(lire("ops/socle/compose.donnees.yml")) as unknown as { services: Record<string, { volumes?: string[]; networks?: string[]; ports?: string[] }>; volumes: Record<string, unknown> };
    expect(Object.keys(compose.services)).toEqual(expect.arrayContaining(["donnees", "pgbouncer-donnees"]));
    expect(compose.services["donnees"]?.networks).toEqual(["interne"]);
    expect(compose.services["donnees"]?.ports).toBeUndefined();
    expect(Object.keys(compose.volumes).length).toBeGreaterThan(0);
  });

  it("[A-199] chaque client a sa propre base, sans schéma par client ni RLS commune", () => {
    expect(superu("postgres", `select count(*) from pg_database where datname in ('cli_${A}','cli_${B}')`).sortie).toBe("2");
    for (const id of [A, B]) {
      expect(superu(`cli_${id}`, "select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by 1").sortie).toBe("public");
      expect(superu(`cli_${id}`, "select count(*) from pg_policies").sortie).toBe("0");
    }
    expect(superu(`cli_${A}`, "select note from essai").sortie).toContain("MARQUEUR-A");
    expect(superu(`cli_${A}`, "select note from essai").sortie).not.toContain("MARQUEUR-B");
  });

  it("[A-167] une base client a ses trois rôles, l'application ne possède rien", () => {
    const attrs = (nom: string) => superu("postgres", `select rolcanlogin::int, rolbypassrls::int, rolsuper::int, rolcreatedb::int, rolcreaterole::int from pg_roles where rolname='${nom}'`).sortie;
    expect(attrs(role(A, "proprietaire"))).toBe("0|0|0|0|0");
    expect(attrs(role(A, "app"))).toBe("1|0|0|0|0");
    expect(attrs(role(A, "lecture"))).toBe("1|0|0|0|0");
    expect(superu("postgres", `select pg_get_userbyid(datdba) from pg_database where datname='cli_${A}'`).sortie).toBe(role(A, "proprietaire"));
    const possede = (r: string) =>
      superu(`cli_${A}`, `select (select count(*) from pg_class where relowner='${r}'::regrole) + (select count(*) from pg_namespace where nspowner='${r}'::regrole) + (select count(*) from pg_proc where proowner='${r}'::regrole)`).sortie;
    expect(possede(role(A, "app"))).toBe("0");
    expect(possede(role(A, "lecture"))).toBe("0");
    expect(Number(possede(role(A, "proprietaire")))).toBeGreaterThan(0);
    // L'application lit et écrit ; la lecture ne fait que lire.
    expect(direct(role(A, "app"), `cli_${A}`, "insert into essai values ('ecrit-par-app')").ok).toBe(true);
    expect(direct(role(A, "lecture"), `cli_${A}`, "select count(*) from essai").ok).toBe(true);
    expect(direct(role(A, "lecture"), `cli_${A}`, "insert into essai values ('x')").ok).toBe(false);
    expect(direct(role(A, "app"), `cli_${A}`, "create table pirate(x int)").ok).toBe(false);
    expect(direct(role(A, "app"), `cli_${A}`, "drop table essai").ok).toBe(false);
    expect(direct(role(A, "app"), `cli_${A}`, `set role ${role(A, "proprietaire")}`).ok).toBe(false);
  });
});

describe("isolation entre clients (C-477, liste d'attaques)", () => {
  it("[C-477] @isolation cli_A_app ne se connecte pas à cli_B, ni directement ni par PgBouncer", () => {
    expect(direct(role(A, "app"), `cli_${A}`, "select 1").ok).toBe(true);
    expect(parPgBouncer(role(A, "app"), `cli_${A}`, "select 1").ok).toBe(true);
    for (const cible of [`cli_${B}`, "postgres", "template1", "modele_v1"]) {
      const d = direct(role(A, "app"), cible, "select 1");
      const p = parPgBouncer(role(A, "app"), cible, "select 1");
      expect({ cible, direct: d.ok, pgbouncer: p.ok }).toEqual({ cible, direct: false, pgbouncer: false });
      expect(d.sortie + p.sortie).not.toContain("MARQUEUR-B");
    }
    expect(parPgBouncer(role(A, "lecture"), `cli_${B}`, "select 1").ok).toBe(false);
  });

  it("[C-477] @isolation REVOKE CONNECT FROM PUBLIC est posé sur chaque base cli_", () => {
    const ouvertes = superu(
      "postgres",
      "select d.datname from pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a where a.grantee = 0 and a.privilege_type = 'CONNECT' order by 1",
    ).sortie;
    expect(ouvertes).toBe("");
    const cli = superu("postgres", "select count(*) from pg_database where datname like 'cli\\_%'").sortie;
    expect(Number(cli)).toBeGreaterThanOrEqual(4);
  });

  it("[C-477] @isolation dblink et postgres_fdw sont indisponibles", () => {
    for (const extension of ["dblink", "postgres_fdw"]) {
      expect(direct(role(A, "app"), `cli_${A}`, `create extension ${extension}`).ok).toBe(false);
      expect(superu(`cli_${A}`, `select count(*) from pg_extension where extname='${extension}'`).sortie).toBe("0");
    }
  });

  it("[C-477] @isolation le provisionneur n'a que la création : il ne lit aucune base client et ne passe pas par PgBouncer", () => {
    expect(superu("postgres", "select rolsuper::int, rolbypassrls::int, rolcreatedb::int, rolcreaterole::int from pg_roles where rolname='provisionneur'").sortie).toBe("0|0|1|1");
    const lecture = psql("donnees", "provisionneur", `cli_${A}`, "select note from essai");
    expect(lecture.ok).toBe(false);
    expect(lecture.sortie).not.toContain("MARQUEUR");
    expect(psql("donnees", "provisionneur", "postgres", `set role ${role(A, "app")}`).ok).toBe(false);
    expect(psql("donnees", "provisionneur", "postgres", `set role ${role(A, "lecture")}`).ok).toBe(false);
    expect(psql("donnees", "provisionneur", "postgres", `set role ${role(A, "proprietaire")}`).ok).toBe(false);
    // PgBouncer ne connaît que les rôles cli_…_app et cli_…_lecture, et le fichier de mots de passe n'a que pgbouncer_auth.
    expect(psql("donnees", "provisionneur", "postgres", "select 1", { hote: "pgbouncer-donnees", port: "6432", motDePasse: "TEST-NE-PAS-UTILISER-faux" }).ok).toBe(false);
  });

  it("[C-477] @isolation un client ne lit ni les mots de passe ni les données d'un autre dans les catalogues", () => {
    expect(direct(role(A, "app"), `cli_${A}`, "select count(*) from pg_authid").ok).toBe(false);
    expect(direct(role(A, "app"), `cli_${A}`, "select count(*) from pg_shadow").ok).toBe(false);
    const roles = direct(role(A, "app"), `cli_${A}`, "select rolname, rolpassword from pg_roles where rolname like 'cli\\_%'");
    expect(roles.ok).toBe(true);
    for (const l of roles.sortie.split("\n")) {
      expect(l).toMatch(/^cli_[0-9a-f]{12}_(proprietaire|app|lecture)\|(\*{8})?$/);
    }
    const noms = direct(role(A, "app"), `cli_${A}`, "select datname from pg_database");
    for (const n of noms.sortie.split("\n")) expect(n).toMatch(/^(cli_[0-9a-f]{12}|postgres|template[01]|modele_v\d+)$/);
  });

  it("[C-477] @isolation l'état d'une session de A ne survit pas à sa transaction sur PgBouncer", async () => {
    const h = adresse("pgbouncer-donnees");
    const a = clientPg(h, 6432, role(A, "app"), `cli_${A}`, mdpDe(role(A, "app")));
    await a.connect();
    await a.query("select set_config('essai.secret', 'VALEUR-DE-A', false)");
    await a.end();
    for (const [id, nom] of [[A, "app"], [B, "app"]] as const) {
      const c = clientPg(h, 6432, role(id, nom), `cli_${id}`, mdpDe(role(id, nom)));
      await c.connect();
      const r = await c.query("select current_setting('essai.secret', true) as v");
      await c.end();
      expect(r.rows[0]?.v ?? "").toBe("");
    }
  }, 60_000);
});

describe("PgBouncer de la grappe données (A-234, A-235, A-236, A-210)", () => {
  const ini = () => lire("ops/socle/donnees/pgbouncer.ini");
  it("[A-234] PgBouncer de la grappe données est en mode transaction avec default_pool_size 2 ; pool_size 4 et 8 se règlent par base", async () => {
    expect(ini()).toMatch(/^pool_mode\s*=\s*transaction$/m);
    expect(ini()).toMatch(/^default_pool_size\s*=\s*2$/m);
    expect(ini()).toMatch(new RegExp(`^cli_${P4}\\s*=.*pool_size=4`, "m"));
    expect(ini()).toMatch(new RegExp(`^cli_${P8}\\s*=.*pool_size=8`, "m"));
    expect(ini()).toMatch(/^auth_query\s*=.*pgbouncer\.chercher_utilisateur/m);
    expect(existsSync(racine("ops/socle/donnees/userlist.txt"))).toBe(false);
    const h = adresse("pgbouncer-donnees");
    for (const [id, attendu] of [[A, 2], [P4, 4], [P8, 8]] as const) {
      const clients = Array.from({ length: attendu + 1 }, () => clientPg(h, 6432, role(id, "app"), `cli_${id}`, mdpDe(role(id, "app"))));
      const tenus = clients.map((c) => c.connect().then(() => c.query("begin; select 1")).then(() => true, () => false));
      await new Promise((ok) => setTimeout(ok, 4000));
      expect({ id, serveurs: serveurs(id) }).toEqual({ id, serveurs: attendu });
      await Promise.allSettled(clients.map((c) => c.end()));
      await Promise.allSettled(tenus);
    }
  }, 180_000);

  it("[A-235] une connexion inactive est fermée après 30 s", async () => {
    expect(ini()).toMatch(/^server_idle_timeout\s*=\s*30$/m);
    expect(parPgBouncer(role(B, "app"), `cli_${B}`, "select 1").ok).toBe(true);
    expect(serveurs(B)).toBeGreaterThan(0);
    expect(await attendre(() => serveurs(B) === 0, 50)).toBe(true);
  }, 90_000);

  describe("charge de 200 bases", () => {
    const ids = bases(200);
    beforeAll(() => creerPlusieurs(ids), 600_000);
    const motDePasse = (r: string) => `TEST-NE-PAS-UTILISER-charge-${r.endsWith("app") ? "app" : "lecture"}`;

    it("[A-210] l'essai de 50 bases à 2 connexions est mesuré et écrit", async () => {
      const h = adresse("pgbouncer-donnees");
      const cinquante = ids.slice(0, 50);
      const clients = cinquante.flatMap((id) => [0, 1].map(() => clientPg(h, 6432, role(id, "app"), `cli_${id}`, motDePasse(role(id, "app")))));
      await Promise.all(clients.map((c) => c.connect()));
      const latences: number[] = [];
      const fin = Date.now() + 10_000;
      let erreurs = 0;
      await Promise.all(
        clients.map(async (c) => {
          while (Date.now() < fin) {
            const t = performance.now();
            try {
              await c.query("select 1");
              latences.push(performance.now() - t);
            } catch (e) {
              if (erreurs++ === 0) writeSync(2, `A-210 première erreur : ${(e as Error).message}\n`);
            }
          }
        }),
      );
      await Promise.allSettled(clients.map((c) => c.end()));
      latences.sort((x, y) => x - y);
      const debit = Math.round(latences.length / 10);
      const pct = (p: number) => (latences[Math.floor(latences.length * p)] ?? 0).toFixed(1);
      writeSync(2, `MESURE A-210 : 50 bases, 2 connexions chacune, ${debit} requêtes/s, latence p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, ${erreurs} erreurs\n`);
      expect(erreurs).toBe(0);
      expect(debit).toBeGreaterThan(0);
      const md = existsSync(racine("ops/donnees/mesure-pgbouncer.md")) ? lire("ops/donnees/mesure-pgbouncer.md") : "";
      expect(md).toMatch(/50 bases/);
      expect(md).toMatch(/requêtes par seconde/);
      expect(md).toMatch(/Conclusion : (validé|à revoir)/);
    }, 120_000);

    it("[A-236] la grappe refuse au-delà de 250 connexions serveur sans priver une base existante", async () => {
      const h = adresse("pgbouncer-donnees");
      const existante = clientPg(h, 6432, role(A, "app"), `cli_${A}`, mdpDe(role(A, "app")));
      await existante.connect();
      await existante.query("begin; select 1");
      const clients = ids.flatMap((id) => [0, 1].map(() => clientPg(h, 6432, role(id, "app"), `cli_${id}`, motDePasse(role(id, "app")))));
      const issues = await Promise.all(
        clients.map((c) => c.connect().then(() => c.query("begin; select 1")).then(() => "ouverte", (e: Error) => (/too many|timeout|pool|limit|failing|reserved|no more/i.test(e.message) || "severity" in e ? "refus propre" : `autre : ${e.message}`))),
      );
      writeSync(2, `A-236 issues : ${JSON.stringify([...new Set(issues.map((x) => x.slice(0, 120)))])}\n`);
      const ouvertes = issues.filter((x) => x === "ouverte").length;
      expect(issues.filter((x) => x.startsWith("autre"))).toEqual([]);
      expect(ouvertes).toBeGreaterThan(0);
      expect(issues.filter((x) => x === "refus propre").length).toBeGreaterThan(0);
      expect(Number(superu("postgres", "select count(*) from pg_stat_activity where usename like 'cli\\_%'").sortie)).toBeLessThanOrEqual(250);
      // La base qui tenait déjà sa connexion la garde.
      expect((await existante.query("select 1 as v")).rows[0]?.v).toBe(1);
      await Promise.allSettled([existante.end(), ...clients.map((c) => c.end())]);
      // PgBouncer garde ses connexions serveur 30 s : on attend qu'elles retombent avant les essais suivants.
      expect(await attendre(() => toutesLesConnexions() === 0, 80)).toBe(true);
    }, 300_000);
  });
});

describe("limites par base (A-417)", () => {
  it("[A-417] une requête qui dépasse le délai est coupée et les autres clients répondent", async () => {
    const h = adresse("donnees");
    const lent = clientPg(h, 5432, role(A, "app"), `cli_${A}`, mdpDe(role(A, "app")));
    const autre = clientPg(h, 5432, role(B, "app"), `cli_${B}`, mdpDe(role(B, "app")));
    await Promise.all([lent.connect(), autre.connect()]);
    const coupee = lent.query("select pg_sleep(60)").then(() => "finie", (e: Error) => e.message);
    expect((await autre.query("select 1 as v")).rows[0]?.v).toBe(1);
    expect(await coupee).toMatch(/statement timeout/);
    await Promise.allSettled([lent.end(), autre.end()]);
  }, 90_000);

  it("[A-417] un client ne peut pas ouvrir plus que sa limite de connexions", async () => {
    const h = adresse("donnees");
    const limite = Number(superu("postgres", `select rolconnlimit from pg_roles where rolname='${role(A, "app")}'`).sortie);
    expect(limite).toBeGreaterThan(0);
    // Les connexions que PgBouncer garde encore ouvertes pour ce rôle comptent dans sa limite.
    const deja = Number(superu("postgres", `select count(*) from pg_stat_activity where usename='${role(A, "app")}'`).sortie);
    const clients = Array.from({ length: limite + 1 }, () => clientPg(h, 5432, role(A, "app"), `cli_${A}`, mdpDe(role(A, "app"))));
    const issues = await Promise.all(clients.map((c) => c.connect().then(() => "ouverte", (e: Error) => e.message)));
    expect(issues.filter((x) => x === "ouverte")).toHaveLength(limite - deja);
    expect(issues.find((x) => x !== "ouverte")).toMatch(/too many connections for role/);
    await Promise.allSettled(clients.map((c) => c.end()));
  }, 90_000);
});

describe("règle d'architecture (C-497)", () => {
  it("[C-497] la règle « une base par client, schéma par client au-delà de 5 000 seulement » est écrite dans l'ADR 0046", () => {
    const adr = lire("docs/adr/0046-bases-des-clients.md");
    expect(adr).toMatch(/Une base PAR client/);
    expect(adr).toMatch(/schéma par client/i);
    expect(adr).toMatch(/5 000 clients/);
    expect(adr).toMatch(/hors V1/);
    expect(adr).toMatch(/C-497/);
  });
});
