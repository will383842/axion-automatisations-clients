import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { deriverCleIntention } from "../../packages/contrats/src/c4/intention.ts";
import { avecClient } from "../../apps/executeur/src/db/connexion.ts";
import type { ClientMailpit } from "../../packages/harnais/src/mailpit.ts";
import { demarrerFauxGraph } from "../../packages/harnais/src/faux-graph/serveur.ts";

// « pg » n'est pas une dépendance de la racine : on le prend chez l'exécuteur.
const pg = createRequire(new URL("../../apps/executeur/package.json", import.meta.url))("pg") as { Pool: new (o: object) => { on(e: string, f: () => void): void; end(): Promise<void> } };

// Arrêt brutal (C-470) : 50 exécutions du module d'exemple contre le faux Graph, le travailleur tué par SIGKILL à des instants tirés au sort, relancé, puis les messages reçus comptés dans un piège SMTP local (le socle n'a pas de Mailpit).
// Le travailleur est un processus enfant (jamais le processus du test) lancé avec le même Node : son code est écrit ici, le seul fichier de cette fiche à cet endroit.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cible(service: string, port: number, surcharge: string | undefined): { host: string; port: number } {
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  const modele = '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}';
  return { host: docker("inspect", "-f", modele, conteneur(service)), port };
}
function secret(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const ligne = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n").find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="));
  if (!ligne) throw new Error("mot de passe de test introuvable");
  return ligne.slice("SOCLE_PG_MOT_DE_PASSE=".length);
}
const PGBOUNCER = cible("pgbouncer", 6432, process.env["SOCLE_PG_PGBOUNCER"]);
const MOT_DE_PASSE = createHash("sha256").update(`${secret()}/moteur_app`).digest("hex");
const app = new pg.Pool({ ...PGBOUNCER, user: "moteur_app", database: "moteur", password: MOT_DE_PASSE, max: 4, connectionTimeoutMillis: 10_000 });
app.on("error", () => undefined);

const racine = fileURLToPath(new URL("../../", import.meta.url));
const url = (chemin: string) => pathToFileURL(`${racine}${chemin}`).href;

// Code du travailleur : même noyau, mêmes adaptateurs PostgreSQL, connecteur HTTP vers le faux Graph. Le sujet du message porte la clé d'intention.
const TRAVAILLEUR = `
import { defineAutomation } from ${JSON.stringify(url("packages/sdk-module/src/index.ts"))};
import { manifesteExemple } from ${JSON.stringify(url("packages/sdk-module/exemples/module-exemple.ts"))};
import { Machine, ConsoleFactice, HorlogeSysteme } from ${JSON.stringify(url("apps/executeur/src/noyau/index.ts"))};
import { BoitePostgres } from ${JSON.stringify(url("apps/executeur/src/noyau/postgres/boite-envoi.ts"))};
import { JournalPostgres } from ${JSON.stringify(url("apps/executeur/src/noyau/postgres/journal-etapes.ts"))};
import { createRequire } from "node:module";
// « pg » vient de l'exécuteur : un code lancé par -e ne le trouve pas depuis la racine.
const pg = createRequire(${JSON.stringify(url("apps/executeur/package.json"))})("pg");
const e = JSON.parse(process.env.TRAVAIL);
// Signaux vers le test (sortie d'erreur, une ligne chacun) : « ECRITE » dès que l'intention est validée en base, « VERIFIE » à chaque vérification après coup.
const signal = (ligne) => process.stderr.write(ligne + "\\n");
const pool = new pg.Pool({ host: e.pg.host, port: e.pg.port, user: "moteur_app", database: "moteur", password: e.pg.mdp, max: 2 });
const graph = (chemin, init) => fetch(e.graph + "/v1.0/me" + chemin, { ...init, headers: { authorization: "Bearer faux.compte@exemple.fr", "content-type": "application/json" } });
const connecteurs = {
  async appeler(_action, d) {
    const r = await graph("/messages", { method: "POST", body: JSON.stringify({ subject: "axion " + d.cle, body: { contentType: "text", content: "x" }, toRecipients: [{ emailAddress: { address: "destinataire@exemple.fr" } }] }) });
    const { id } = await r.json();
    // Envoi ralenti : la fenêtre « intention écrite, pas encore faite » devient large, la mort brutale y tombe presque toujours.
    await new Promise((ok) => setTimeout(ok, e.lenteurMs));
    await graph("/messages/" + id + "/send", { method: "POST" });
  },
  async verifier(_action, cle) {
    try {
      const r = await graph("/mailFolders/SentItems/messages", { method: "GET" });
      const { value } = await r.json();
      const reponse = value.some((m) => m.subject === "axion " + cle) ? "trouvee" : "absente";
      signal("VERIFIE " + reponse);
      return reponse;
    } catch { return "inconnue"; }
  },
};
const module = defineAutomation({ ...manifesteExemple, etapes: [{ nom: "e1", delaiMaxSecondes: 5, executer: async (ctx) => { await ctx.effet("envoyer", "msg-1", {}); } }], connecteurs: [{ famille: "messagerie", actions: ["envoyer"], portees: ["envoi"], garantie: "verifiable_apres_coup" }] });
// Marge courte (500 ms au lieu de 60 s) : une intention bloquée par un travailleur mort redevient reprenable après 5,5 s.
const boite = new BoitePostgres(pool, e.tenant, { graceMs: 500 });
const ecrire = boite.ecrire.bind(boite);
boite.ecrire = async (...a) => { const r = await ecrire(...a); if (r.creee) signal("ECRITE"); return r; };
const ports = { journal: new JournalPostgres(pool, e.tenant), boite, connecteurs, console: new ConsoleFactice({ reglages: { actionsAutomatiquesAutorisees: ["envoyer"], objetAccuse: "Accusé" } }), horloge: new HorlogeSysteme() };
for (const exec of e.executions) await new Machine({ module, ports }).lancer(e.instance, exec);
await pool.end();
`;

// Piège à e-mails local (le socle n'a pas de Mailpit) : un serveur SMTP minimal sur 127.0.0.1 qui garde le sujet de chaque message reçu en entier.
function demarrerPiege(): Promise<{ sujets: string[]; port: number; serveur: Server }> {
  const sujets: string[] = [];
  const serveur = createServer((s) => {
    let donnees = false;
    let tampon = "";
    s.write("220 piege.test ESMTP\r\n");
    s.on("error", () => undefined);
    s.on("data", (b) => {
      tampon += b.toString("latin1");
      if (donnees) {
        if (!tampon.includes("\r\n.\r\n")) return;
        const sujet = /^Subject: (.*)$/im.exec(tampon)?.[1]?.trim();
        if (sujet) sujets.push(sujet);
        donnees = false;
        tampon = "";
        s.write("250 ok\r\n");
        return;
      }
      for (const ligne of tampon.split("\r\n").filter(Boolean)) {
        const cmd = ligne.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") s.write("250 piege.test\r\n");
        else if (cmd === "DATA") {
          donnees = true;
          s.write("354 go\r\n");
        } else if (cmd === "QUIT") s.end("221 bye\r\n");
        else s.write("250 ok\r\n");
      }
      if (!donnees) tampon = "";
      else tampon = tampon.slice(tampon.toUpperCase().lastIndexOf("DATA") + 4).replace(/^\r\n/, "");
    });
  });
  return new Promise((ok) => serveur.listen(0, "127.0.0.1", () => ok({ sujets, port: (serveur.address() as { port: number }).port, serveur })));
}

const vivants = new Set<ChildProcess>();
const compter = async (tenant: string) => Number((await avecClient(app as never, tenant, (c) => c.query<{ n: string }>("SELECT count(*)::text AS n FROM intentions"))).rows[0]?.n ?? 0);
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});
afterAll(async () => {
  for (const p of vivants) p.kill("SIGKILL");
  await app.end().catch(() => undefined);
});

function lancerTravailleur(travail: object) {
  const enfant = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", TRAVAILLEUR], {
    cwd: racine,
    env: { ...process.env, TRAVAIL: JSON.stringify(travail) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  vivants.add(enfant);
  const signaux = { ecrites: 0, verifiees: 0, trouvees: 0 };
  let reste = "";
  enfant.stderr?.on("data", (b: Buffer) => {
    const lignes = (reste + b.toString()).split("\n");
    reste = lignes.pop() ?? "";
    for (const l of lignes) {
      if (l === "ECRITE") signaux.ecrites++;
      else if (l.startsWith("VERIFIE ")) {
        signaux.verifiees++;
        if (l === "VERIFIE trouvee") signaux.trouvees++;
      }
      else writeSync(2, `enfant : ${l}\n`);
    }
  });
  const fini = new Promise<number | null>((ok) => enfant.on("exit", (code) => (vivants.delete(enfant), ok(code))));
  // Attend le n-ième signal « intention écrite » ; faux si l'enfant a fini avant.
  const attendreEcrites = async (n: number) => {
    while (signaux.ecrites < n) {
      if (enfant.exitCode !== null) return false;
      await new Promise((ok) => setTimeout(ok, 5));
    }
    return true;
  };
  return { enfant, fini, signaux, attendreEcrites };
}

describe("arrêt brutal du travailleur, avec le socle", { timeout: 300_000 }, () => {
  it("[C-470] @anti-doublon arrêt brutal (SIGKILL) tiré au sort, 50 exécutions : chaque message exactement une fois dans le piège à e-mails, ou son intention en a_trancher", async () => {
    const piege = await demarrerPiege();
    const ancienEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "test";
    const graph = await demarrerFauxGraph({ mailpit: { smtp: { host: "127.0.0.1", port: piege.port } } as ClientMailpit });
    try {
      const tenant = randomUUID();
      const instance = randomUUID();
      const executions = Array.from({ length: 50 }, () => randomUUID());
      for (const id of executions) {
        await avecClient(app as never, tenant, (c) => c.query("INSERT INTO executions (tenant_id, id, instance_id, automatisation, debut) VALUES ($1, $2, $3, 'accuse-reception', now())", [tenant, id, instance]));
      }
      // Graine écrite au journal : un échec se rejoue avec GRAINE_C470=<graine>.
      let graine = Number(process.env["GRAINE_C470"] ?? Math.floor(Math.random() * 2_147_483_647)) || 470;
      writeSync(2, `C-470 : graine ${graine}\n`);
      const alea = () => (graine = (graine * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
      const lenteurMs = 250;
      const travail = { tenant, instance, executions, graph: graph.url, lenteurMs, pg: { host: PGBOUNCER.host, port: PGBOUNCER.port, mdp: MOT_DE_PASSE } };
      const bloquees = async () => new Set((await avecClient(app as never, tenant, (c) => c.query<{ cle_intention: string }>("SELECT cle_intention FROM intentions WHERE etat = 'ecrite'"))).rows.map((r) => r.cle_intention));
      // Six morts : chaque enfant est tué après un nombre tiré au sort de signaux « intention écrite » (1 à 5), plus un court délai tiré au sort, pendant l'envoi ralenti.
      let morts = 0;
      let mortsDansLaFenetre = 0;
      let verifiees = 0;
      let avant = await bloquees();
      for (let vie = 0; vie < 6; vie++) {
        const t = lancerTravailleur(travail);
        const atteint = await Promise.race([t.attendreEcrites(1 + Math.floor(alea() * 5)), t.fini.then(() => false)]);
        if (!atteint) break;
        await new Promise((ok) => setTimeout(ok, Math.floor(alea() * 120)));
        if (t.enfant.exitCode === null) {
          t.enfant.kill("SIGKILL");
          morts++;
        }
        await t.fini;
        verifiees += t.signaux.verifiees;
        // Preuve en base, pas dans le signal : une intention encore « ecrite » qui ne l'était pas avant cette vie = mort tombée après l'intention écrite, avant « faite ».
        const apres = await bloquees();
        if ([...apres].some((k) => !avant.has(k))) mortsDansLaFenetre++;
        avant = apres;
      }
      writeSync(2, `C-470 : ${morts} morts brutales, ${mortsDansLaFenetre} dans la fenêtre (intention écrite, pas faite)\n`);
      expect(morts, "au moins 3 morts brutales").toBeGreaterThanOrEqual(3);
      expect(mortsDansLaFenetre, "au moins 3 morts dans la fenêtre intention écrite / faite").toBeGreaterThanOrEqual(3);
      // Les passes suivantes finissent le travail ; une intention bloquée redevient reprenable après la marge (5,5 s), jusque-là elle est reportée.
      for (let passe = 0; passe < 8 && (await bloquees()).size + (50 - (await compter(tenant))) > 0; passe++) {
        if (passe > 0) await new Promise((ok) => setTimeout(ok, 3000));
        const f = lancerTravailleur(travail);
        expect(await f.fini).toBe(0);
        verifiees += f.signaux.verifiees;
      }
      expect(await bloquees(), "plus aucune intention écrite sans issue").toEqual(new Set());
      expect(await compter(tenant), "une intention par exécution").toBe(50);
      expect(verifiees, "au moins une intention résolue par verifier()").toBeGreaterThanOrEqual(1);

      const parCle = new Map<string, number>();
      for (const sujet of piege.sujets) parCle.set(sujet, (parCle.get(sujet) ?? 0) + 1);
      const intentions = await avecClient(app as never, tenant, (c) => c.query<{ cle_intention: string; etat: string }>("SELECT cle_intention, etat FROM intentions"));
      const etat = new Map(intentions.rows.map((r) => [r.cle_intention, r.etat]));
      const manques: string[] = [];
      for (const exec of executions) {
        const cle = deriverCleIntention({ instanceId: instance, executionId: exec, etape: "e1", action: "envoyer", element: "msg-1" });
        const n = parCle.get(`axion ${cle}`) ?? 0;
        expect(n, `exécution ${exec} : aucun message en double`).toBeLessThanOrEqual(1);
        if (n === 0 && etat.get(cle) !== "a_trancher") manques.push(exec);
      }
      expect(manques).toEqual([]);
    } finally {
      if (ancienEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = ancienEnv;
      await graph.arreter();
      piege.serveur.close();
    }
  });
});
