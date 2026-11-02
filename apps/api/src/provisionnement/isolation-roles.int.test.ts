import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { sqlPg } from "./adaptateur-sql.js";
import { adminPg, nomBaseDe, nomsRoles, type Admin } from "./etapes-base.js";

// Dettes de T2-34 n° 9 et n° 8 (propriétaire T2-35) : essais sur une grappe jetable où init.sql a été joué.
// T235_PG_ADMIN_URL = adresse DIRECTE du rôle provisionneur vers la base d'administration ; T235_PGBOUNCER_URL = adresse de PgBouncer (même grappe), facultative.
// Sans T235_PG_ADMIN_URL ces essais ne tournent pas ; le job socle-integration doit la fournir. Aucun secret dans le dépôt : mots de passe tirés au hasard à chaque essai.
const ADMIN = process.env["T235_PG_ADMIN_URL"];
const BOUNCER = process.env["T235_PGBOUNCER_URL"];
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
const pool = (base: string) => { const p = new pg.Pool({ connectionString: adresse(base), max: 1 }); pools.push(p); return p; };
// Connexion avec un rôle de client ; rend le code d'erreur PostgreSQL (« 28P01 », « 42501 »…) ou « ok ».
async function connecter(base: string, role: string, motDePasse: string, hote = ADMIN): Promise<string> {
  const c = new pg.Client({ connectionString: adresse(base, role, motDePasse, hote) });
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

describe.skipIf(!ADMIN)("fermeture des bases sur une grappe jetable", () => { // fiche: T2-35
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

  it.skipIf(!BOUNCER)("[A-216] @isolation à travers PgBouncer : le rôle _app d'un autre client est refusé, le sien accepté", async () => { // fiche: T2-35
    const a = await creerClient();
    const b = await creerClient();
    const ra = nomsRoles(a.id);
    const rb = nomsRoles(b.id);
    expect(await connecter(a.base, ra.app, MDP[ra.app]!, BOUNCER)).toBe("ok");
    expect(await connecter(a.base, rb.app, MDP[rb.app]!, BOUNCER)).not.toBe("ok");
    expect(await connecter(b.base, ra.app, MDP[ra.app]!, BOUNCER)).not.toBe("ok");
  }, 60_000);

  it("[A-216] un secret désaccordé après la fermeture ne peut plus être corrigé par le provisionneur (échec, décision humaine)", async () => {
    const a = await creerClient();
    const ra = nomsRoles(a.id);
    await expect(admin.poserRole(ra.app, empreinte(mdp()), 99)).rejects.toThrow();
    // Le rôle garde son ancien mot de passe : rien n'a été à moitié appliqué.
    expect(await connecter(a.base, ra.app, MDP[ra.app]!)).toBe("ok");
  }, 60_000);
});
