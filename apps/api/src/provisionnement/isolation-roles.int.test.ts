import { execFileSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { sqlPg } from "./adaptateur-sql.js";
import { adminPg, nomBaseDe, nomsRoles, type Admin } from "./etapes-base.js";
import { ecrireEchec, journalEchecs } from "./journal-echecs.js";
// Journal des échecs (CI) : le rapport JSON n'est pas publié ; la cause de chaque test rouge s'imprime ici, adresses de connexion masquées.
journalEchecs(import.meta.url);

// Dettes de T2-34 n° 9 et n° 8 (propriétaire T2-35) : essais sur une grappe jetable où init.sql a été joué.
// T235_PG_ADMIN_URL = adresse DIRECTE du rôle provisionneur vers la base d'administration ; T235_PGBOUNCER_URL = adresse de PgBouncer (même grappe) ; sans elles, calculées sur le socle.
// Un .int.test.ts ne tourne que sous SOCLE_INTEGRATION=1 : une grappe introuvable FAIT ÉCHOUER l'essai, jamais un saut silencieux.
// Aucun secret dans le dépôt : mots de passe tirés au hasard à chaque essai.
// Adresses : les variables restent prioritaires ; sinon calculées sur la grappe jetable du socle (socket Unix de l'hôte posée par compose.zz-essai-donnees.yml, IP de PgBouncer). Échec, jamais saut.
const docker = (...a: string[]) => {
  try { return execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) {
    ecrireEchec("docker", a[0] ?? "", (e as { stderr?: string }).stderr ?? (e as Error).message, 300);
    throw e;
  }
};
const conteneur = (service: string) => {
  const id = docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
  if (!id) throw new Error(`conteneur ${service} introuvable : le socle doit tourner (ops/socle/lancer.sh, fragment d'essai)`);
  return id;
};
const adresseAdmin = () => {
  const mdp = docker("exec", conteneur("donnees"), "sh", "-c", 'printf %s/provisionneur "$SOCLE_PG_MOT_DE_PASSE" | sha256sum | cut -c1-64');
  return `postgresql://provisionneur:${mdp}@localhost/postgres?host=%2Ftmp%2Fsocle-donnees-socket`;
};
const adresseBouncer = () => `postgresql://x:x@${docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', conteneur("pgbouncer-donnees"))}:6432/postgres`;
const ADMIN = process.env["T235_PG_ADMIN_URL"] ?? adresseAdmin();
const BOUNCER = process.env["T235_PGBOUNCER_URL"] ?? adresseBouncer();
const empreinte = (mdp: string) => {
  const sel = randomBytes(16);
  const sale = pbkdf2Sync(mdp, sel, 4096, 32, "sha256");
  const hmac = (cle: Buffer, texte: string) => createHmac("sha256", cle).update(texte).digest();
  return `SCRAM-SHA-256$4096:${sel.toString("base64")}$${createHash("sha256").update(hmac(sale, "Client Key")).digest("base64")}:${hmac(sale, "Server Key").toString("base64")}`;
};
const mdp = () => `TEST-NE-PAS-UTILISER-${randomBytes(12).toString("hex")}`;
const adresse = (base: string, utilisateur?: string, motDePasse?: string, hote = ADMIN) => {
  const u = new URL(hote ?? "postgres://x@localhost/postgres");
  u.pathname = `/${base}`;
  if (utilisateur) { u.username = utilisateur; u.password = motDePasse ?? ""; }
  return u.toString();
};
const pools: pg.Pool[] = [];
// Un pool sans écouteur « error » fait tomber le processus (connexion inactive coupée à la fermeture d'une base) : l'erreur reste dans l'essai.
const pool = (base: string) => { const p = new pg.Pool({ connectionString: adresse(base), max: 1, connectionTimeoutMillis: 15_000 }); p.on("error", () => undefined); pools.push(p); return p; };
// Connexion avec un rôle de client ; rend le code d'erreur PostgreSQL (« 28P01 », « 42501 »…) ou « ok ».
async function connecter(base: string, role: string, motDePasse: string, hote = ADMIN): Promise<string> {
  const c = new pg.Client({ connectionString: adresse(base, role, motDePasse, hote), connectionTimeoutMillis: 15_000 });
  c.on("error", () => undefined);
  try { await c.connect(); await c.query("SELECT 1"); return "ok"; } catch (e) { return (e as { code?: string }).code ?? "erreur"; } finally { await c.end().catch(() => undefined); }
}
const admin_ = pool("postgres");
const admin: Admin = adminPg(sqlPg(admin_), (b) => sqlPg(pool(b)));
const MDP: Record<string, string> = {};

async function creerClient(): Promise<{ id: string; base: string }> {
  const id = randomUUID();
  const base = nomBaseDe(id);
  await admin.creerBase(base, "modele_v1");
  let v = 0;
  for (const role of Object.values(nomsRoles(id))) { MDP[role] = mdp(); await admin.poserRole(role, empreinte(MDP[role]), ++v); }
  await admin.fermer(base);
  return { id, base };
}
afterAll(async () => { await Promise.all(pools.map((p) => p.end().catch(() => undefined))); });

describe("fermeture des bases sur une grappe jetable", () => { // fiche: T2-35
  it("la grappe jetable et PgBouncer répondent (échec, pas saut)", async () => {
    expect((await admin_.query("SELECT current_user AS u")).rows[0]?.u).toBe("provisionneur");
    const c = new pg.Client({ connectionString: BOUNCER, connectionTimeoutMillis: 15_000 });
    c.on("error", () => undefined);
    await c.connect().then(() => c.end(), (e: { code?: string }) => { expect(["28P01", "08P01"]).toContain(e.code); });
  }, 30_000);
  it("[A-216] @isolation le rôle _app d'un autre client ne se connecte pas à cli_<id>, le sien oui", async () => {
    const a = await creerClient();
    const b = await creerClient();
    const ra = nomsRoles(a.id);
    const rb = nomsRoles(b.id);
    expect(await connecter(a.base, ra.app, MDP[ra.app]!)).toBe("ok");
    expect(await connecter(a.base, rb.app, MDP[rb.app]!)).toBe("42501");
    expect(await connecter(a.base, rb.lecture, MDP[rb.lecture]!)).toBe("42501");
    expect(await connecter(a.base, rb.proprietaire, "x")).not.toBe("ok");
    expect(await connecter(b.base, ra.app, MDP[ra.app]!)).toBe("42501");
    // Le provisionneur lui-même n'a plus de passage chez le client (A-216 : accès retiré).
    expect(await admin.accesProvisionneurRetire(a.base)).toBe(true);
  }, 60_000);

  it("[A-216] @isolation à travers PgBouncer : le rôle _app d'un autre client est refusé, le sien accepté", async () => { // fiche: T2-35
    const a = await creerClient();
    const b = await creerClient();
    const ra = nomsRoles(a.id);
    const rb = nomsRoles(b.id);
    // Contrôles positifs : chaque rôle _app entre par PgBouncer sur SA base (sans eux, un refus ne prouverait rien).
    expect(await connecter(a.base, ra.app, MDP[ra.app]!, BOUNCER)).toBe("ok");
    expect(await connecter(b.base, rb.app, MDP[rb.app]!, BOUNCER)).toBe("ok");
    // Refus : EXACTEMENT 42501. Le mot de passe est bon (PgBouncer authentifie), c'est le CONNECT de la base qui est refusé par le serveur et relayé ; 28P01 ou 08P01 (authentification, protocole) ne prouveraient rien sur CONNECT.
    expect(await connecter(a.base, rb.app, MDP[rb.app]!, BOUNCER)).toBe("42501");
    expect(await connecter(b.base, ra.app, MDP[ra.app]!, BOUNCER)).toBe("42501");
  }, 60_000);

  it("[A-216] un secret désaccordé après la fermeture ne peut plus être corrigé par le provisionneur (échec, décision humaine)", async () => {
    const a = await creerClient();
    const ra = nomsRoles(a.id);
    await expect(admin.poserRole(ra.app, empreinte(mdp()), 99)).rejects.toThrow();
    // Le rôle garde son ancien mot de passe : rien n'a été à moitié appliqué.
    expect(await connecter(a.base, ra.app, MDP[ra.app]!)).toBe("ok");
  }, 60_000);
});
