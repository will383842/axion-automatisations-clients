import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { avecClient } from "../db/client-actif.js";
import { migrer } from "../db/migrer.js";
import { deposer, transactionOuverte } from "./boite-envoi.js";
import { magasinPg } from "./relais.js";

// Boîte d'envoi (T2-14) sur la vraie base. Socle lancé par ops/socle/lancer.sh (job socle-integration).
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

const app = pool(PGBOUNCER, "console_app", 40);
const equipe = pool(PGBOUNCER, "console_equipe", 3);
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };
const RETROUVER = "/api/console/v1/clients/retrouver-ou-creer";
const corpsHub = (n: string) => ({ consoleClientId: `console-cli-${n}`, raisonSociale: "Atelier Bertin", adresse: { ligne1: "1 rue d'essai", codePostal: "75001", ville: "Ville-Test", pays: "FR" }, contactFacturation: { nom: "Camille Test", email: "contact@exemple.fr" } });
const creerOrg = (id: string) => avecClient(app, id, (c) => c.query("INSERT INTO organisations (tenant_id, id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Boulangerie Rivoire')", [id]), APPELANT);
const compter = (tenant: string) => avecClient(app, tenant, async (c) => (await c.query("SELECT count(*)::int AS n FROM boite_envoi WHERE tenant_id = $1", [tenant])).rows[0]?.n as number);
const intention = (n: string) => ({ destination: "hub" as const, route: RETROUVER, methode: "POST" as const, corps: corpsHub(n), intention: `retrouver:${n}` });

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

describe("boîte d'envoi avec le socle", { timeout: 30_000 }, () => {
  it("[C-402] @anti-doublon la ligne est écrite dans la même transaction que le changement ; une annulation n'écrit rien", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await expect(avecClient(app, A, async (c) => {
      await deposer(transactionOuverte(c), intention("annule"));
      throw new Error("changement métier annulé");
    })).rejects.toThrow(/annulé/);
    expect(await compter(A)).toBe(0);
    const r = await avecClient(app, A, (c) => deposer(transactionOuverte(c), intention("valide")));
    expect(r.nouveau).toBe(true);
    expect(await compter(A)).toBe(1);
  });

  it("[C-402] @anti-doublon un dépôt hors de la transaction d'un client est refusé", async () => {
    const connexion = await app.connect();
    try {
      await expect(deposer(transactionOuverte(connexion), intention("hors"))).rejects.toThrow(/transaction/);
    } finally { connexion.release(); }
  });

  it("[C-535] @anti-doublon 10 dépôts parallèles de la même intention : une ligne", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const r = await Promise.all(Array.from({ length: 10 }, () => avecClient(app, A, (c) => deposer(transactionOuverte(c), intention("meme")))));
    expect(new Set(r.map((x) => x.cle)).size).toBe(1);
    expect(r.filter((x) => x.nouveau)).toHaveLength(1);
    expect(await compter(A)).toBe(1);
  });

  it("[C-403] @envoi cycle de la ligne sur la base : prise, report, échec visible par l'équipe, renvoi avec la même clé", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const d = await avecClient(app, A, (c) => deposer(transactionOuverte(c), intention("cycle")));
    const magasin = magasinPg(app, equipe);
    const ref = { tenantId: A, id: d.id };
    const maintenant = new Date();
    const ligne = await magasin.prendre(ref, maintenant);
    expect([ligne?.cle, ligne?.nombreEssais]).toEqual([d.cle, 1]);
    expect(await magasin.prendre(ref, maintenant)).toBeNull();
    await magasin.reporter(ref, { prochainEssai: new Date(maintenant.getTime() + 60_000), erreur: "reseau", compter: true });
    expect((await magasin.dues("hub", maintenant, 10)).some((x) => x.id === d.id)).toBe(false);
    expect((await magasin.dues("hub", new Date(maintenant.getTime() + 61_000), 10)).some((x) => x.id === d.id)).toBe(true);
    await magasin.prendre(ref, maintenant);
    await magasin.conclure(ref, { etat: "echec", erreur: "reseau" });
    expect((await magasin.echecs()).find((e) => e.id === d.id)).toMatchObject({ tenantId: A, nombreEssais: 2, derniereErreur: "reseau" });
    expect(await magasin.renvoyer(ref, APPELANT)).toBe(true);
    const apres = await magasin.prendre(ref, new Date());
    expect([apres?.cle, apres?.nombreEssais]).toEqual([d.cle, 1]);
  });

  it("[A-088] @envoi une ligne en cours depuis plus de 2 minutes repasse à envoyer avec la même clé", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const d = await avecClient(app, A, (c) => deposer(transactionOuverte(c), intention("abandon")));
    const magasin = magasinPg(app, equipe);
    const ref = { tenantId: A, id: d.id };
    await magasin.prendre(ref, new Date(Date.now() - 300_000));
    expect(await magasin.reprendre(new Date(Date.now() - 120_000))).toBeGreaterThanOrEqual(1);
    expect((await magasin.prendre(ref, new Date()))?.cle).toBe(d.cle);
  });

  it("[C-403] [C-535] renvoyer écrit l'acteur au journal d'audit et refuse une ligne de plus de 30 jours sans confirmation", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const magasin = magasinPg(app, equipe);
    const poser = async (n: string, jours: number) => {
      const d = await avecClient(app, A, (c) => deposer(transactionOuverte(c), intention(n)));
      await avecClient(app, A, (c) => c.query("UPDATE boite_envoi SET etat = 'echec', derniere_erreur = 'reseau', cree_le = now() - make_interval(days => $3) WHERE tenant_id = $1 AND id = $2", [A, d.id, jours]));
      return { tenantId: A, id: d.id };
    };
    const vieille = await poser("vieille", 31);
    await expect(magasin.renvoyer(vieille, APPELANT)).rejects.toThrow(/30 jours/);
    expect(await magasin.renvoyer(vieille, APPELANT, { confirmerAnciennete: true })).toBe(true);
    const recente = await poser("recente", 29);
    expect(await magasin.renvoyer(recente, APPELANT)).toBe(true);
    const lignes = await avecClient(app, A, async (c) => (await c.query("SELECT acteur, entite_id FROM public.journal_audit WHERE tenant_id = $1 AND entite = 'boite_envoi' AND action = 'modification' AND nouvelle->>'action' = 'renvoi'", [A])).rows);
    expect(lignes.map((l) => [l["acteur"], l["entite_id"]]).sort()).toEqual([["agent-essai", vieille.id], ["agent-essai", recente.id]].sort());
  });
});
