import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it, onTestFailed } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import type { ErreurCoffre as ErreurCoffreType, OptionsBao } from "../coffre/coffre.js";
import { ErreurCoffre } from "../coffre/coffre.js";
import { creerEnveloppe } from "../coffre/enveloppe.js";
import { creerColonnesChiffrees } from "./colonnes-chiffrees.js";
import { creerPersonnesChiffrees } from "./personnes-chiffrees.js";

// T2-54 : commun.personnes sur un VRAI PostgreSQL et un VRAI OpenBao, lancés par le test (mêmes images que le socle). Mots de passe et jetons tirés au lancement.
// Chaque essai cherche le marqueur, en clair et en hexadécimal, dans le texte brut de la table puis dans les fichiers de la base.
const racineDepot = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const compose = (f: string) => lireYaml(readFileSync(racineDepot(f), "utf8")) as unknown as { services: Record<string, { image: string }> };
const lances: string[] = [];
const pools: pg.Pool[] = [];
afterAll(async () => {
  for (const p of pools) await p.end().catch(() => undefined);
  for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ }
});
// Écrit sur la sortie d'erreur (le rapport JSON de la CI avale console.log) : à l'échec, seul le nom de l'erreur et un message tronqué, jamais de valeur.
const trace = (m: string) => writeSync(2, `PERSONNES-INT ${m}\n`);
async function suivre<T>(nom: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    trace(`échec « ${nom} » : ${(e as Error).name} ${(e as Error).message.slice(0, 300)}`);
    throw e;
  }
}
const adresse = (id: string) => docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
const attendre = async (pret: () => Promise<boolean>, quoi: string) => {
  for (let i = 0; ; i++) {
    try { if (await pret()) return; } catch { /* démarrage */ }
    if (i > 90) throw new Error(`${quoi} non démarré`);
    await new Promise((ok) => setTimeout(ok, 500));
  }
};

async function lancerOpenBao(): Promise<OptionsBao> {
  const racine = `TEST-NE-PAS-UTILISER-${randomBytes(12).toString("hex")}`;
  const id = docker("run", "-d", "--rm", "-e", `BAO_DEV_ROOT_TOKEN_ID=${racine}`, "-e", "BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200", compose("ops/socle/compose.openbao.yml").services["openbao"]!.image, "server", "-dev");
  lances.push(id);
  const url = `http://${adresse(id)}:8200`;
  await attendre(async () => (await fetch(`${url}/v1/sys/health`)).status === 200, "OpenBao de test");
  const admin = (corps: unknown, chemin: string) => fetch(`${url}/v1/${chemin}`, { method: "POST", headers: { "X-Vault-Token": racine, "Content-Type": "application/json" }, body: JSON.stringify(corps) });
  await admin({ type: "transit" }, "sys/mounts/transit");
  await admin({ policy: readFileSync(racineDepot("ops/socle/openbao/politiques/api.hcl"), "utf8") }, "sys/policies/acl/api");
  const r = (await (await admin({ policies: ["api"], no_default_policy: true }, "auth/token/create")).json()) as { auth: { client_token: string } };
  return { url, jeton: r.auth.client_token };
}

async function lancerPostgres(): Promise<{ pool: pg.Pool; conteneur: string }> {
  const mdp = randomBytes(16).toString("hex");
  const id = docker("run", "-d", "--rm", "-e", `POSTGRES_PASSWORD=${mdp}`, compose("ops/socle/compose.postgres.yml").services["postgres"]!.image);
  lances.push(id);
  const hote = adresse(id);
  const sonde = () => new pg.Pool({ host: hote, user: "postgres", password: mdp, database: "postgres", max: 1 });
  await attendre(async () => { const p = sonde(); try { await p.query("SELECT 1"); return true; } finally { await p.end(); } }, "PostgreSQL de test");
  // La base de l'essai reçoit la structure du modèle client (T2-32), telle que le dépôt la définit.
  const admin = sonde();
  await admin.query("CREATE DATABASE cli_essai");
  await admin.end();
  const pool = new pg.Pool({ host: hote, user: "postgres", password: mdp, database: "cli_essai", max: 2 });
  pools.push(pool);
  const dossier = racineDepot("apps/api/drizzle-cli");
  for (const morceau of readFileSync(`${dossier}/0000_modele_base_client.sql`, "utf8").split("--> statement-breakpoint")) if (morceau.trim()) await pool.query(morceau);
  return { pool, conteneur: id };
}

// Cherche une suite d'octets dans tous les fichiers du répertoire de données (tables, journal d'écriture) : 1 si trouvée, 0 si absente ; toute autre issue de grep est une erreur, jamais une absence.
function dansLesFichiers(conteneur: string, motif: string): number {
  try {
    docker("exec", conteneur, "sh", "-c", `grep -rlaF -e '${motif}' "$PGDATA" > /dev/null`);
    return 1;
  } catch (e) {
    if ((e as { status?: number }).status === 1) return 0;
    throw e;
  }
}

async function preparer() {
  const bao = await suivre("OpenBao", lancerOpenBao);
  const { pool, conteneur } = await suivre("PostgreSQL", lancerPostgres);
  const env = creerEnveloppe(bao);
  const colonnes = creerColonnesChiffrees(bao);
  const A = randomUUID();
  const B = randomUUID();
  for (const t of [A, B]) {
    await env.creerCleClient(t);
    const r = await fetch(`${bao.url}/v1/transit/keys/cli-${t}-recherche`, { method: "POST", headers: { "X-Vault-Token": bao.jeton, "Content-Type": "application/json" }, body: JSON.stringify({ type: "aes256-gcm96", exportable: false }) });
    if (!r.ok) throw new Error(`clé de recherche : HTTP ${r.status}`);
  }
  const etab = (await pool.query<{ id: string }>("INSERT INTO commun.etablissements (nom) VALUES ('Siège Garage Fontaine') RETURNING id")).rows[0]!.id;
  return { pool, conteneur, colonnes, A, B, etab, personnes: creerPersonnesChiffrees({ colonnes, sql: pool }) };
}

describe("commun.personnes chiffrée, PostgreSQL et OpenBao réels", () => {
  it("[A-243] un e-mail rangé dans commun.personnes est chiffré ; la base ne contient pas la valeur en clair (marqueur cherché dans le texte brut de la table)", async () => {
    onTestFailed(({ task }) => { trace(`essai rouge : ${(task.result?.errors?.[0]?.message ?? "").slice(0, 400)}`); });
    const { pool, conteneur, personnes, A, etab } = await preparer();
    const marqueur = `marq${randomBytes(8).toString("hex")}@exemple.fr`;
    const id = await personnes.ranger(A, { etablissementId: etab, nom: "Pellegrand", prenom: "Lucien", courriel: marqueur });
    const hex = Buffer.from(marqueur).toString("hex");
    const brut = (await pool.query<{ t: string }>("SELECT p::text AS t FROM commun.personnes p")).rows.map((r) => r.t).join("\n");
    expect(brut).toContain("\\x"); // le texte brut n'est pas vide : les octets chiffrés y sont bien (bytea en hexadécimal)
    expect(brut).not.toContain(marqueur);
    expect(brut).not.toContain(hex);
    expect(brut).not.toContain(marqueur.split("@")[0]!);
    await pool.query("CHECKPOINT");
    expect(dansLesFichiers(conteneur, marqueur)).toBe(0);
    expect(dansLesFichiers(conteneur, marqueur.split("@")[0]!)).toBe(0);
    expect((await personnes.lire(A, id))?.courriel).toBe(marqueur);
  }, 180_000);

  it("[A-243] l'empreinte rangée fait 32 octets et retrouve la personne", async () => {
    onTestFailed(({ task }) => { trace(`essai rouge : ${(task.result?.errors?.[0]?.message ?? "").slice(0, 400)}`); });
    const { pool, personnes, A, B, etab } = await preparer();
    const courriel = `retrouve${randomBytes(6).toString("hex")}@personnes.test`;
    const id = await personnes.ranger(A, { etablissementId: etab, nom: "Sablonnier", courriel });
    const l = (await pool.query<{ n: number }>("SELECT octet_length(courriel_empreinte) AS n FROM commun.personnes WHERE id = $1", [id])).rows[0];
    expect(l?.n).toBe(32);
    expect(await personnes.trouverParCourriel(A, etab, courriel.toUpperCase())).toEqual([id]);
    expect(await personnes.trouverParCourriel(B, etab, courriel)).toEqual([]); // l'empreinte de B n'est pas celle de A
  }, 180_000);

  it("[A-201] le téléphone rangé est chiffré de la même façon", async () => {
    onTestFailed(({ task }) => { trace(`essai rouge : ${(task.result?.errors?.[0]?.message ?? "").slice(0, 400)}`); });
    const { pool, conteneur, personnes, A, etab } = await preparer();
    const telephone = "+33 6 39 98 04 17";
    const id = await personnes.ranger(A, { etablissementId: etab, nom: "Lavernette", telephone });
    const brut = (await pool.query<{ t: string }>("SELECT p::text AS t FROM commun.personnes p WHERE id = $1", [id])).rows[0]!.t;
    for (const forme of [telephone, "+33639980417", "0639980417", Buffer.from("+33639980417").toString("hex"), Buffer.from(telephone).toString("hex")]) expect(brut).not.toContain(forme);
    await pool.query("CHECKPOINT");
    expect(dansLesFichiers(conteneur, "+33639980417")).toBe(0);
    const l = (await pool.query<{ n: number }>("SELECT octet_length(telephone_empreinte) AS n FROM commun.personnes WHERE id = $1", [id])).rows[0];
    expect(l?.n).toBe(32);
    expect((await personnes.lire(A, id))?.telephone).toBe(telephone);
  }, 180_000);

  it("[A-243] @isolation le courriel d'une personne copié sur une autre ligne ne se lit pas", async () => {
    onTestFailed(({ task }) => { trace(`essai rouge : ${(task.result?.errors?.[0]?.message ?? "").slice(0, 400)}`); });
    const { pool, personnes, A, B, etab } = await preparer();
    const un = await personnes.ranger(A, { etablissementId: etab, nom: "Dufresnoy", courriel: "alienor.dufresnoy@exemple.fr" });
    const deux = await personnes.ranger(A, { etablissementId: etab, nom: "Chaumeil", courriel: "basile.chaumeil@exemple.fr" });
    await pool.query("UPDATE commun.personnes SET courriel_chiffre = (SELECT courriel_chiffre FROM commun.personnes WHERE id = $1) WHERE id = $2", [un, deux]);
    const refus: ErreurCoffreType = await personnes.lire(A, deux).then(() => { throw new Error("lecture acceptée"); }, (e: unknown) => e as ErreurCoffreType);
    expect(refus).toBeInstanceOf(ErreurCoffre);
    await expect(personnes.lire(B, un)).rejects.toBeInstanceOf(ErreurCoffre); // et la clé d'un autre client ne lit rien
    expect((await personnes.lire(A, un))?.courriel).toBe("alienor.dufresnoy@exemple.fr");
  }, 180_000);
});
