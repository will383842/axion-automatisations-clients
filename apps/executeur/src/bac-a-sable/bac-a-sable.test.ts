import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignataireMemoire, signerArtefact } from "../../../../packages/sdk-module/src/emballage/signer.js";
import { type ClePublique } from "../../../../packages/sdk-module/src/emballage/cles-publiques.js";
import { estMessageEnfant, type Json, estMessageParent } from "./canal.ts";
import { LIMITES_DEFAUT } from "./limites.ts";
import { executerIsole } from "./processus.ts";
import { ModuleNonSigneError } from "../noyau/charger-module.ts";
import { executerEnBac, BacFerme } from "../files/travailleur.ts";

const octets = (t: string) => new TextEncoder().encode(t);
const signataire = new SignataireMemoire("test-1");
const cles: ClePublique[] = [{ idCle: "test-1", publique: signataire.clePublique }];
// Un module d'essai : le corps de executer(entree, contexte), signé comme en production.
const module = (corps: string) =>
  signerArtefact({ "module.js": octets(`export async function executer(entree, contexte) { ${corps} }`), "manifest.json": octets('{"nom":"demo"}') }, signataire);
const lancer = (corps: string, entree: Json = null, jeton?: string, limites = LIMITES_DEFAUT) =>
  executerIsole(module(corps), { executionId: "exec-1", entree, jeton, cles, limites });

afterEach(() => vi.unstubAllEnvs());

describe("bac à sable : processus jetable", () => {
  it("[A-328] @isolation deux exécutions de deux clients n'ont jamais le même processus (identifiants de processus relevés)", async () => {
    const a = await lancer("return process.pid;");
    const b = await lancer("return process.pid;");
    expect(a).toMatchObject({ statut: "fait" });
    expect(b).toMatchObject({ statut: "fait" });
    const pids = [a, b].map((r) => (r.statut === "fait" ? r.valeur : 0));
    expect(new Set([...pids, process.pid]).size).toBe(3);
  });

  it("[A-328] @isolation une variable globale posée par l'exécution A n'existe pas dans l'exécution B", async () => {
    await lancer("globalThis.secretDeA = 'a'; return 1;");
    const b = await lancer("return typeof globalThis.secretDeA;");
    expect(b).toEqual({ statut: "fait", valeur: "undefined" });
  });

  it("[A-328] l'enfant est tué à la fin : le processus n'existe plus", async () => {
    const r = await lancer("return process.pid;");
    const pid = r.statut === "fait" ? (r.valeur as number) : 0;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("[A-328] l'enfant ne peut lire aucun fichier hors de l'artefact", async () => {
    for (const chemin of ["/etc/passwd", `/proc/${process.pid}/environ`, "/proc/self/environ", import.meta.filename]) {
      const r = await lancer(`const fs = await import('node:fs'); try { fs.readFileSync(${JSON.stringify(chemin)}); return 'lu'; } catch (e) { return e.code; }`);
      expect(r, chemin).toEqual({ statut: "fait", valeur: "ERR_ACCESS_DENIED" });
    }
  });

  it("[A-328] l'enfant ne peut écrire aucun fichier", async () => {
    const r = await lancer("const fs = await import('node:fs'); try { fs.writeFileSync('/tmp/bac-intrus.txt', 'x'); return 'ecrit'; } catch (e) { return e.code; }");
    expect(r).toEqual({ statut: "fait", valeur: "ERR_ACCESS_DENIED" });
  });

  it("[A-328] ni child_process, ni worker_threads, ni process.binding", async () => {
    const corps = (essai: string) => `try { ${essai}; return 'ok'; } catch (e) { return e.code; }`;
    const spawn = await lancer(corps("(await import('node:child_process')).spawnSync('ls')"));
    const worker = await lancer(corps("new (await import('node:worker_threads')).Worker('1', { eval: true })"));
    const binding = await lancer(corps("process.binding('tcp_wrap')"));
    expect([spawn, worker, binding]).toEqual(Array(3).fill({ statut: "fait", valeur: "ERR_ACCESS_DENIED" }));
  });

  it("[A-328] l'environnement de l'enfant est vide sauf l'identifiant d'exécution", async () => {
    vi.stubEnv("SECRET_DU_PARENT", "ne-doit-pas-passer");
    const r = await lancer("return process.env;");
    expect(r).toEqual({ statut: "fait", valeur: { AXION_EXECUTION_ID: "exec-1" } });
  });

  it("[A-330] @isolation l'enfant n'a aucune variable de base de données, même si le parent en porte", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://console.test/console");
    vi.stubEnv("PGHOST", "console.test");
    const r = await lancer("return Object.keys(process.env).filter((k) => /DATABASE|PG|POSTGRES|DB/i.test(k));");
    expect(r).toEqual({ statut: "fait", valeur: [] });
  });

  it("[A-328] le jeton court passe par le canal et jamais par l'environnement", async () => {
    const r = await lancer("return { jeton: contexte.jeton, dansEnv: JSON.stringify(process.env).includes('jeton-court') };", null, "jeton-court-1");
    expect(r).toEqual({ statut: "fait", valeur: { jeton: "jeton-court-1", dansEnv: false } });
  });

  it("[A-328] un module non signé est refusé avant tout lancement", async () => {
    const a = module("return 1;");
    a["module.js"] = octets("export async function executer() { return 2; }");
    await expect(executerIsole(a, { executionId: "exec-2", entree: null, cles, limites: LIMITES_DEFAUT })).rejects.toBeInstanceOf(ModuleNonSigneError);
  });

  it("[A-328] une boucle sans fin est tuée à la durée limite", async () => {
    const t0 = Date.now();
    const r = await lancer("for (;;) {}", null, undefined, { ...LIMITES_DEFAUT, dureeMs: 500 });
    expect(r).toEqual({ statut: "delai_depasse" });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("[A-328] une mémoire épuisée arrête l'enfant sans gêner le parent", async () => {
    const r = await lancer("const t = []; for (;;) t.push(new Array(1e6).fill(1));", null, undefined, { ...LIMITES_DEFAUT, memoireMo: 32 });
    expect(r.statut).toBe("echec");
    expect(await lancer("return 'vivant';")).toEqual({ statut: "fait", valeur: "vivant" });
  });

  it("[A-328] une erreur du module revient sans fuite de pile", async () => {
    const r = await lancer("throw new Error('boum');");
    expect(r).toEqual({ statut: "echec", message: "boum" });
  });
});

describe("bac à sable : réseau", () => {
  let serveur: Server | undefined;
  afterEach(() => void serveur?.close());
  const ecouter = async () => {
    const contacts: string[] = [];
    serveur = createServer((s) => (contacts.push("connexion"), s.destroy()));
    await new Promise<void>((ok) => serveur!.listen(0, "127.0.0.1", ok));
    return { port: (serveur.address() as { port: number }).port, contacts };
  };

  it("[A-329] @isolation l'enfant ne joint aucun hôte (connexion TCP, fetch, UDP, DNS refusés)", async () => {
    const { port, contacts } = await ecouter();
    const essais = {
      tcp: `await new Promise((ok, ko) => { const s = net.connect(${port}, '127.0.0.1'); s.on('connect', ok); s.on('error', ko); })`,
      fetch: `await fetch('http://127.0.0.1:${port}/')`,
      udp: "await new Promise((ok, ko) => { const s = dgram.createSocket('udp4'); s.send('x', 9, '127.0.0.1', (e) => (e ? ko(e) : ok())); })",
      dns: "await new Promise((ok, ko) => dns.lookup('exemple.test', (e) => (e ? ko(e) : ok())))",
    };
    for (const [nom, essai] of Object.entries(essais)) {
      const r = await lancer(`const net = await import('node:net'); const dgram = await import('node:dgram'); const dns = await import('node:dns'); try { ${essai}; return 'joint'; } catch (e) { return e.code ?? e.cause?.code ?? e.message; }`);
      expect(r, nom).toEqual({ statut: "fait", valeur: "ERR_ACCESS_DENIED" });
    }
    expect(contacts).toEqual([]);
  });
});

describe("bac à sable : DNS et signaux", () => {
  // Tout ce qui peut sortir par DNS, par chemin : fonctions de dns et dns.promises, Resolver des deux espaces, import nommé.
  it("[A-329] @isolation aucune fonction DNS n'est utilisable (resolve*, lookupService, Resolver, imports nommés)", async () => {
    const r = await lancer(`
      const dns = await import('node:dns'); const dnsp = await import('node:dns/promises'); const nomme = await import('node:dns');
      const ouverts = [];
      const sonde = async (nom, f) => { try { await f(); ouverts.push(nom); } catch (e) { if (e.code !== 'ERR_ACCESS_DENIED') ouverts.push(nom + ':' + (e.code ?? e.message)); } };
      const fonctions = (o) => Object.keys(o).filter((k) => typeof o[k] === 'function' && /^(lookup|lookupService|reverse|resolve.*)$/.test(k));
      for (const k of fonctions(dns.default)) await sonde('dns.' + k, () => dns.default[k]('exemple.test', () => {}));
      for (const k of fonctions(dnsp.default)) await sonde('dnsp.' + k, () => dnsp.default[k]('exemple.test'));
      for (const k of fonctions(dns.default.Resolver.prototype)) await sonde('Resolver.' + k, () => new dns.default.Resolver()[k]('exemple.test', () => {}));
      for (const k of fonctions(dns.default.promises.Resolver.prototype)) await sonde('promises.Resolver.' + k, () => new dns.default.promises.Resolver()[k]('exemple.test'));
      await sonde('nomme.lookup', () => nomme.lookup('exemple.test', () => {}));
      await sonde('nomme.resolveTxt', () => nomme.resolveTxt('exemple.test', () => {}));
      await sonde('promises.lookupService', () => dnsp.lookupService('127.0.0.1', 22));
      return ouverts;`);
    expect(r).toEqual({ statut: "fait", valeur: [] });
  });

  it("[A-328] @isolation l'enfant ne peut signaler ni le parent ni un autre enfant", async () => {
    const voisin = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      const pid = voisin.pid as number;
      const r = await lancer(
        `const codes = []; const essai = (f) => { try { f(); codes.push('ok'); } catch (e) { codes.push(e.code); } };
         essai(() => process.kill(entree.voisin, 'SIGKILL')); essai(() => process.kill(process.ppid, 0));
         essai(() => process._kill(entree.voisin, 9));
         const nomme = await import('node:process'); essai(() => nomme.kill(entree.voisin, 'SIGKILL'));
         return codes;`,
        { voisin: pid },
      );
      expect(r).toEqual({ statut: "fait", valeur: ["ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED"] });
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      voisin.kill("SIGKILL");
    }
  });
});

describe("bac à sable : canal", () => {
  it("[A-328] le canal n'accepte que des messages typés, sans fonction", () => {
    expect(estMessageParent({ type: "lancer", code: "eA==", entree: { a: 1 }, executionId: "e" })).toBe(true);
    expect(estMessageParent({ type: "lancer", code: "eA==", entree: () => 1, executionId: "e" })).toBe(false);
    expect(estMessageParent({ type: "autre" })).toBe(false);
    expect(estMessageParent(null)).toBe(false);
    expect(estMessageEnfant({ type: "resultat", valeur: [1, "a", null] })).toBe(true);
    expect(estMessageEnfant({ type: "resultat", valeur: { f: () => 1 } })).toBe(false);
    expect(estMessageEnfant({ type: "erreur", message: 3 })).toBe(false);
  });
});

describe("travailleur : lancement par le bac à sable", () => {
  const travail = { id: "t1", instanceId: "inst-1", clientId: "client-a", palier: "pro" as const };
  it("[A-328] l'interrupteur est fermé par défaut : aucun lancement", async () => {
    const executer = executerEnBac(async () => module("return 1;"), { cles });
    await expect(executer(travail)).rejects.toBeInstanceOf(BacFerme);
  });
  it("[A-328] interrupteur ouvert : le travail tourne dans un processus enfant", async () => {
    const executer = executerEnBac(async () => module("return 1;"), { actif: true, cles });
    await expect(executer(travail)).resolves.toBeUndefined();
  });
  it("[A-328] un échec de l'enfant fait échouer le travail", async () => {
    const executer = executerEnBac(async () => module("throw new Error('x');"), { actif: true, cles });
    await expect(executer(travail)).rejects.toThrow("bac_a_sable_echec");
  });
});
