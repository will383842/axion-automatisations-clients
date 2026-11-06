import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyserModele, executerLecture } from "@axion-auto/donnees-module";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.ts";
import { journalEchecs } from "../../../api/src/provisionnement/journal-echecs.ts";
import type { BaseLecture } from "../courtier/client.ts";
import { creerFabriquePort, type ConnexionLecture, type PortsLecture } from "./port.ts";
journalEchecs(import.meta.url);

// Essai réel (job socle-integration, Docker) : lancé seulement en CI, aucun résultat inventé hors CI. Données générées.
// Un seul PostgreSQL, deux bases (deux « clients ») : cli_aaaaaaaaaaaa et cli_bbbbbbbbbbbb, chacune avec son rôle _lecture (SELECT seul).
const racine = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const IDS = { a: "cli_" + "a".repeat(12), b: "cli_" + "b".repeat(12) } as const;
const T = { a: "11111111-1111-4111-8111-111111111111", b: "22222222-2222-4222-8222-222222222222" } as const;
const ETAB = { a: "44444444-4444-4444-8444-444444444444", b: "55555555-5555-4555-8555-555555555555" } as const;
const INST = "33333333-3333-4333-8333-333333333333";
const COR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DDL = 'CREATE TABLE "commun"."etablissements" (\n  "id" uuid PRIMARY KEY\n);\nCREATE TABLE "commun"."factures_essai" (\n  "id" uuid PRIMARY KEY,\n  "etablissement_id" uuid NOT NULL,\n  "libelle" text\n);';
const MODELE = analyserModele(DDL);
const DONNEES = { requetes: [{ nom: "liste-factures", mode: "lecture", parametres: { motif: { type: "texte", max: 20 } }, forme: { type: "simple", table: "commun.factures_essai", sortie: { lignes: [{ colonne: "libelle" }] }, filtres: [{ colonne: "libelle", operateur: "egal", parametre: "motif" }], limite: { fixe: 10 } } }], actions: [] };
const mdp = randomBytes(16).toString("hex");
const mdpLecture = randomBytes(16).toString("hex");
let conteneur = "";
let hote = "";
const ouvrirPg = (database: string, user = "postgres", password = user === "postgres" ? mdp : mdpLecture) => new pg.Client({ host: hote, user, password, database });

beforeAll(async () => {
  const image = (lireYaml(readFileSync(racine("ops/socle/compose.postgres.yml"), "utf8")) as unknown as { services: Record<string, { image: string }> }).services["postgres"]!.image;
  conteneur = docker("run", "-d", "--rm", "-e", `POSTGRES_PASSWORD=${mdp}`, image);
  hote = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", conteneur).split(" ")[0] ?? "";
  for (let i = 0; ; i++) {
    const c = ouvrirPg("postgres");
    try { await c.connect(); await c.end(); break; } catch (e) {
      await c.end().catch(() => undefined);
      if (i > 90) throw e;
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
  const admin = ouvrirPg("postgres");
  await admin.connect();
  for (const k of ["a", "b"] as const) {
    await admin.query(`CREATE ROLE ${IDS[k]}_lecture LOGIN PASSWORD '${mdpLecture}'`);
    await admin.query(`CREATE DATABASE ${IDS[k]}`);
  }
  await admin.end();
  for (const k of ["a", "b"] as const) {
    const c = ouvrirPg(IDS[k]);
    await c.connect();
    await c.query(`CREATE SCHEMA commun; ${DDL.replaceAll('"commun".', "commun.").replaceAll('"', "")}`);
    await c.query("INSERT INTO commun.etablissements VALUES ($1)", [ETAB[k]]);
    await c.query("INSERT INTO commun.factures_essai VALUES (gen_random_uuid(), $1, $2)", [ETAB[k], `facture-${k}`]);
    await c.query(`GRANT USAGE ON SCHEMA commun TO ${IDS[k]}_lecture; GRANT SELECT ON ALL TABLES IN SCHEMA commun TO ${IDS[k]}_lecture`);
    await c.end();
  }
}, 180_000);
afterAll(() => { if (conteneur) try { docker("rm", "-f", conteneur); } catch { /* déjà arrêté */ } });

// Ports réels : la connexion est un pg.Client DÉDIÉ, ouvert avec la base et le rôle remis, jamais rendu à un autre appel.
function portsReels(trace: { ouvertes: string[]; detruites: boolean[]; verrou?: Promise<void> | undefined } = { ouvertes: [], detruites: [] }): PortsLecture {
  return {
    instance: async () => ({ empreinte: "sha256:aaaa", installee: true, ecart: false, impaye: false, etat: "actif", donnees: DONNEES }),
    baseLecture: async (tenantId) => ({ hote, base: tenantId === T.a ? IDS.a : IDS.b, role: `${tenantId === T.a ? IDS.a : IDS.b}_lecture`, motDePasse: mdpLecture, expire: new Date(Date.now() + 60_000), valideJusqua: null } satisfies BaseLecture),
    ouvrir: async (b) => {
      trace.ouvertes.push(b.base);
      const c = ouvrirPg(b.base, b.role, b.motDePasse);
      await c.connect();
      const co: ConnexionLecture = { query: (t, v) => c.query(t, v as unknown[]), liberer: (err) => { trace.detruites.push(err !== undefined); void c.end(); } };
      return co;
    },
    tracer: () => undefined,
  };
}

describe("port données sur de vraies bases", () => {
  it("[C-624] @isolation le port n'exécute une requête que dans la base du client de l'exécution (identifiant forgé), avec le rôle _lecture", async () => {
    const trace = { ouvertes: [] as string[], detruites: [] as boolean[] };
    const f = creerFabriquePort(portsReels(trace), { delaiMs: 2000, maxLignes: 50, hotes: [hote] }, MODELE);
    expect(await f({ tenantId: T.a, instanceId: INST, idTache: "tache-1", correlation: COR }).lire("liste-factures", { motif: "facture-a" })).toEqual([{ libelle: "facture-a" }]);
    // La ligne du client B n'est visible ni par le client A ni par un identifiant glissé dans les paramètres.
    const a = f({ tenantId: T.a, instanceId: INST, idTache: "tache-1", correlation: COR });
    expect(await a.lire("liste-factures", { motif: "facture-b" })).toEqual([]);
    await expect(a.lire("liste-factures", { motif: "facture-b", base: IDS.b, tenantId: T.b })).rejects.toMatchObject({ code: "schema_invalide" });
    expect(await f({ tenantId: T.b, instanceId: INST, idTache: "tache-1", correlation: COR }).lire("liste-factures", { motif: "facture-b" })).toEqual([{ libelle: "facture-b" }]);
    expect(trace.ouvertes).toEqual([IDS.a, IDS.a, IDS.b]);
    // Le rôle remis est bien _lecture : il lit, et il ne peut ni insérer ni passer en lecture-écriture.
    const c = ouvrirPg(IDS.a, `${IDS.a}_lecture`);
    await c.connect();
    try {
      expect((await c.query("SELECT current_user AS u")).rows[0]).toEqual({ u: `${IDS.a}_lecture` });
      await expect(c.query("INSERT INTO commun.factures_essai VALUES (gen_random_uuid(), $1, 'x')", [ETAB.a])).rejects.toMatchObject({ code: "42501" });
      await c.query("BEGIN READ WRITE");
      await expect(c.query("INSERT INTO commun.factures_essai VALUES (gen_random_uuid(), $1, 'x')", [ETAB.a])).rejects.toMatchObject({ code: "42501" });
    } finally { await c.end(); }
  }, 60_000);

  it("[A-170] une requête qui dépasse le délai est coupée sans bloquer les autres clients", async () => {
    // Un verrou exclusif tenu sur la table du client A fait attendre la lecture de A ; celle de B, dans une autre base, répond.
    const proprio = ouvrirPg(IDS.a);
    await proprio.connect();
    await proprio.query("BEGIN; LOCK TABLE commun.factures_essai IN ACCESS EXCLUSIVE MODE");
    try {
      const trace = { ouvertes: [] as string[], detruites: [] as boolean[] };
      const f = creerFabriquePort(portsReels(trace), { delaiMs: 300, maxLignes: 50, hotes: [hote] }, MODELE);
      const debut = Date.now();
      const lenteA = f({ tenantId: T.a, instanceId: INST, idTache: "tache-1", correlation: COR }).lire("liste-factures", { motif: "facture-a" }).catch((e) => e);
      const rapideB = await f({ tenantId: T.b, instanceId: INST, idTache: "tache-1", correlation: COR }).lire("liste-factures", { motif: "facture-b" });
      expect(rapideB).toEqual([{ libelle: "facture-b" }]);
      expect(Date.now() - debut).toBeLessThan(250 + 3000);
      expect(await lenteA).toMatchObject({ code: "indisponible" });
      expect(Date.now() - debut).toBeLessThan(3000);
    } finally { await proprio.query("ROLLBACK").catch(() => undefined); await proprio.end(); }
  }, 60_000);
});

describe("executerLecture sur de vraies transactions (dettes de #186)", () => {
  it("[A-170] une transaction déjà ouverte par l'appelant est refusée et son écriture n'est pas validée", async () => {
    const admin = ouvrirPg(IDS.a);
    await admin.connect();
    await admin.query("CREATE TABLE IF NOT EXISTS public.trace_essai (n int)");
    const c = ouvrirPg(IDS.a);
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("INSERT INTO public.trace_essai VALUES (1)");
      const err = await executerLecture(c, { texte: "SELECT $1::int AS n", valeurs: [1] }, { delaiMs: 1000 }).catch((e) => e);
      expect(err).toMatchObject({ connexionPerdue: true });
    } finally { await c.end(); } // release(err) : la connexion est détruite, la transaction de l'appelant est annulée
    expect((await admin.query("SELECT count(*)::int AS n FROM public.trace_essai")).rows[0]).toEqual({ n: 0 });
    await admin.end();
  }, 30_000);

  it("[A-170] une transaction avortée sur la connexion est rendue connexionPerdue et jamais remise au pool", async () => {
    const c = ouvrirPg(IDS.a);
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT 1/0").catch(() => undefined);
      const err = await executerLecture(c, { texte: "SELECT $1::int AS n", valeurs: [1] }, { delaiMs: 1000 }).catch((e) => e);
      expect(err).toMatchObject({ connexionPerdue: true });
      expect(err.code).not.toBe("25P02"); // jamais l'erreur brute de la base
    } finally { await c.end(); }
  }, 30_000);
});
