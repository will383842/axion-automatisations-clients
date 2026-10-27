import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { creerPool } from "../../apps/api/src/plugins/base.ts";
import { creerFluxJournal, creerMasqueur } from "../../apps/api/src/plugins/journal.ts";
import { construireServeur } from "../../apps/api/src/serveur.ts";
import { scannerTexte } from "../../scripts/scanner-journaux.ts";

// Porte du lot 1-A (T1A-19, partie A) : journaux en boîte noire. Aucune valeur de secret et aucune donnée d'un client dans le journal
// des conteneurs du socle ni dans celui de l'API. Les valeurs cherchées sont lues dans les conteneurs au lancement ; seuls des NOMS
// (conteneur, variable) sortent dans les messages d'échec, jamais une valeur.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
const ipInterne = (service: string) => docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', conteneur(service));

// Le job ne montre pas le rapport JSON : chaque échec et le bilan du fichier vont sur la sortie d'erreur (jamais une valeur secrète).
const FICHIER = import.meta.url.split("/").pop() ?? "";
const bilan = { verts: 0, rouges: 0, attendus: 0 };
// Une erreur hors de tout test (socket, minuterie) fait échouer le job sans nommer de test : on la nomme (nom et code, jamais le message),
// et le fichier échoue en fin de course (écouter l'événement retire à Vitest son propre constat : on le rend ici).
const nonGerees: string[] = [];
for (const evenement of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(evenement, (e: unknown) => {
    const err = e instanceof Error ? e : new Error(typeof e);
    nonGerees.push(`${evenement} ${err.name}`);
    writeSync(2, `ERREUR NON GEREE ${FICHIER} (${evenement}) : ${err.name} ${(err as { code?: string }).code ?? ""} ${(err.stack ?? "").split("\n").filter((l) => l.includes("audit-1a")).slice(0, 2).map((l) => l.trim()).join(" | ")}\n`);
  });
}
afterEach((ctx) => {
  const r = ctx.task.result;
  const rouge = r?.state === "fail";
  if (ctx.task.fails) {
    if (rouge) bilan.attendus++;
    else writeSync(2, `ECHEC ${ctx.task.name}\nattendu rouge (défaut corrigé ?) mais vert\n`);
  } else if (rouge) {
    bilan.rouges++;
    writeSync(2, `ECHEC ${ctx.task.name}\n${(r.errors ?? []).map((e) => e.message).join("\n")}\n`);
  } else if (r?.state === "pass") bilan.verts++;
});
afterAll(() => {
  writeSync(2, `BILAN ${FICHIER} : ${bilan.verts} verts, ${bilan.rouges} rouges, ${bilan.attendus} défauts attendus\n`);
  if (nonGerees.length > 0) throw new Error(`erreurs hors test : ${nonGerees.join(", ")}`);
});
// Une préparation qui échoue ne passe par aucun afterEach : on l'écrit aussi.
const garder = <T>(f: () => T | Promise<T>) => async () => {
  try {
    return await f();
  } catch (e) {
    writeSync(2, `ECHEC préparation ${FICHIER}\n${e instanceof Error ? e.message : "erreur"}\n`);
    throw e;
  }
};

const SECRET_PAR_NOM = /MOT_DE_PASSE|PASSWORD|SECRET|_CLE$|_CLE_|TOKEN|^M$/;
let secretPg = "";
beforeAll(garder(() => {
  const env = JSON.parse(docker("inspect", "-f", "{{json .Config.Env}}", conteneur("postgres"))) as string[];
  secretPg = env.find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="))?.slice("SOCLE_PG_MOT_DE_PASSE=".length) ?? "";
  if (!secretPg) throw new Error("secret de test du socle introuvable");
}), 60_000);

describe("audit 1-A · journaux des conteneurs du socle", () => {
  it("[A-005] aucun conteneur du socle n'écrit dans son journal un des secrets du socle (bruts ou dérivés par rôle)", () => {
    const ids = docker("ps", "-aq", "--filter", "label=com.docker.compose.project=socle").split("\n").filter(Boolean);
    expect(ids.length).toBeGreaterThan(5);
    // Secrets : variables d'environnement au nom de secret, plus le mot de passe de chaque rôle PostgreSQL (SHA-256 de « secret/rôle »).
    const secrets = new Map<string, string>();
    for (const id of ids) {
      const service = docker("inspect", "-f", '{{index .Config.Labels "com.docker.compose.service"}}', id);
      for (const l of JSON.parse(docker("inspect", "-f", "{{json .Config.Env}}", id)) as string[]) {
        const [nom, ...reste] = l.split("=");
        const valeur = reste.join("=");
        if (nom && SECRET_PAR_NOM.test(nom) && valeur.length >= 12 && !valeur.includes("$")) secrets.set(`${service}:${nom}`, valeur);
      }
    }
    for (const role of ["postgres", "keycloak_app", ...["console", "moteur"].flatMap((b) => [`${b}_migration`, `${b}_app`, `${b}_equipe`])]) {
      secrets.set(`rôle ${role}`, createHash("sha256").update(`${secretPg}/${role}`).digest("hex"));
    }
    expect(secrets.size, "témoin : des secrets ont été trouvés").toBeGreaterThan(10);
    const fuites: string[] = [];
    for (const id of ids) {
      const service = docker("inspect", "-f", '{{index .Config.Labels "com.docker.compose.service"}}', id);
      const r = spawnSync("docker", ["logs", id], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      const journal = `${r.stdout}${r.stderr}`;
      for (const [nom, valeur] of secrets) {
        for (const forme of [valeur, Buffer.from(valeur).toString("base64")]) if (journal.includes(forme)) fuites.push(`${service} ← ${nom}`);
      }
    }
    expect([...new Set(fuites)]).toEqual([]);
  }, 120_000);

  it("[A-005] aucun conteneur du socle n'écrit dans son journal une adresse e-mail réelle ni un IBAN valide", () => {
    const ids = docker("ps", "-aq", "--filter", "label=com.docker.compose.project=socle").split("\n").filter(Boolean);
    const trouvailles: string[] = [];
    for (const id of ids) {
      const service = docker("inspect", "-f", '{{index .Config.Labels "com.docker.compose.service"}}', id);
      const r = spawnSync("docker", ["logs", id], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      for (const t of scannerTexte(service, `${r.stdout}${r.stderr}`)) if (t.type === "e-mail" || t.type === "IBAN") trouvailles.push(`${t.type}, ${service}, ligne ${t.ligne}`);
    }
    expect(trouvailles).toEqual([]);
  }, 120_000);
});

// Journal de l'API : le serveur de l'API (construireServeur) avec son flux masqué, branché sur le socle (console_app à travers PgBouncer).
const A = "5a2b3c4d-0000-4a00-8a00-00000000000a";
const B = "5a2b3c4d-0000-4b00-8b00-00000000000b";
const DONNEE_B = `courriel-de-b-${randomBytes(6).toString("hex")}@exemple.fr`;
const SCHEMA = "audit_journal";
const MODELE = readFileSync(new URL("../../ops/socle/postgres/modele-politique-rls.sql", import.meta.url), "utf8");
let migration: Pool;
let app: Pool;
const motDePasse = (role: string) => createHash("sha256").update(`${secretPg}/${role}`).digest("hex");

describe("audit 1-A · journal de l'API", () => {
  beforeAll(garder(async () => {
    migration = creerPool(`postgres://console_migration:${motDePasse("console_migration")}@${ipInterne("postgres")}:5432/console`);
    app = creerPool(`postgres://console_app:${motDePasse("console_app")}@${ipInterne("pgbouncer")}:6432/console`);
    await migration.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await migration.query(`CREATE SCHEMA ${SCHEMA}; CREATE TABLE ${SCHEMA}.contacts (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, courriel text NOT NULL, UNIQUE (tenant_id, courriel), UNIQUE (courriel))`);
    const c = await migration.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('modele.schema', $1, true), set_config('modele.table', 'contacts', true), set_config('modele.app', 'console_app', true), set_config('modele.equipe', 'console_equipe', true)", [SCHEMA]);
      await c.query(MODELE);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const cb = await app.connect();
    try {
      await cb.query("BEGIN");
      await cb.query("SELECT set_config('app.tenant_id', $1, true)", [B]);
      await cb.query(`INSERT INTO ${SCHEMA}.contacts (tenant_id, courriel) VALUES ($1, $2)`, [B, DONNEE_B]);
      await cb.query("COMMIT");
    } finally {
      cb.release();
    }
  }), 60_000);
  afterAll(async () => {
    await migration?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await app?.end().catch(() => undefined);
    await migration?.end().catch(() => undefined);
  });

  // Un pool par serveur : la fermeture du serveur ferme aussi son pool (plugins/base.ts).
  const serveurAvecJournal = () => {
    const lignes: string[] = [];
    const pool = creerPool(`postgres://console_app:${motDePasse("console_app")}@${ipInterne("pgbouncer")}:6432/console`);
    const serveur = construireServeur({ journal: creerFluxJournal(creerMasqueur(), (l) => lignes.push(l)), pool });
    return { serveur, lignes };
  };

  it("[A-005] le journal de l'API ne garde ni l'en-tête d'authentification, ni le cookie, ni un jeton de coffre, ni le corps d'une requête", async () => {
    const { serveur, lignes } = serveurAvecJournal();
    serveur.post("/essai", async () => {
      throw new Error("échec d'essai");
    });
    const m = (n: string) => `TEST-NE-PAS-UTILISER-${n}-${randomBytes(8).toString("hex")}`;
    const [porteur, cookie, bao, corps] = [m("porteur"), m("cookie"), m("bao"), m("corps")];
    const r = await serveur.inject({ method: "POST", url: "/essai", headers: { authorization: `Bearer ${porteur}`, cookie: `session=${cookie}`, "x-vault-token": bao, "content-type": "application/json" }, payload: { motDePasse: corps } });
    await serveur.close();
    expect(r.statusCode).toBe(500);
    const sortie = lignes.join("");
    expect(sortie, "témoin : la requête est journalisée").toContain("erreur interne");
    expect({ porteur: sortie.includes(porteur), cookie: sortie.includes(cookie), bao: sortie.includes(bao), corps: sortie.includes(corps) }).toEqual({ porteur: false, cookie: false, bao: false, corps: false });
    expect(r.body.includes(porteur) || r.body.includes(corps)).toBe(false);
  });

  // Défaut constaté (T1A-19, PR 90, 1re exécution) : Fastify journalise l'adresse COMPLÈTE de chaque requête, paramètres compris (req.url).
  // Un jeton passé en paramètre (lien magique, code OIDC « code=… », lien signé) entre en clair dans le journal.
  // Correction : un sérialiseur « req » qui retire la partie « ?… » de l'adresse (serveur.ts). À faire avant la première route qui en reçoit.
  it("[A-005] @lot-2 le journal de l'API ne garde pas un jeton passé en paramètre d'adresse", async () => {
    const { serveur, lignes } = serveurAvecJournal();
    const jeton = `TEST-NE-PAS-UTILISER-jeton-${randomBytes(8).toString("hex")}`;
    await serveur.inject({ method: "GET", url: `/connexion/retour?code=${jeton}&state=x` });
    await serveur.close();
    expect(lignes.join("").includes(jeton), "jeton en clair dans le journal").toBe(false);
  });

  // Une erreur PostgreSQL inattendue est journalisée avec l'objet d'erreur (plugins/erreurs.ts, requete.log.error({ err })) ;
  // son champ « detail » porte la valeur en conflit, ici la donnée du client B : elle ne doit pas sortir en clair.
  it("[A-005] @isolation une erreur de base qui porte une donnée d'un autre client (contrainte d'unicité) n'entre pas dans le journal", async () => {
    const { serveur, lignes } = serveurAvecJournal();
    serveur.post("/contacts", async (requete) =>
      requete.avecClient(A, async (c) => {
        await c.query(`INSERT INTO ${SCHEMA}.contacts (tenant_id, courriel) VALUES ($1, $2)`, [A, (requete.body as { courriel: string }).courriel]);
        return { ok: true };
      }),
    );
    const r = await serveur.inject({ method: "POST", url: "/contacts", payload: { courriel: DONNEE_B } });
    await serveur.close();
    expect(r.statusCode, "témoin : l'insertion de A échoue sur la valeur de B").toBe(500);
    expect(r.body.includes(DONNEE_B)).toBe(false);
    expect(lignes.join(""), "témoin : l'erreur de base est journalisée avec son code").toContain("23505");
    expect(lignes.join("").includes(DONNEE_B), "donnée de B dans le journal de l'API").toBe(false);
  });
});
