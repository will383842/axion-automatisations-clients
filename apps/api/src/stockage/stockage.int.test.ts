import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import type { Coffre } from "../coffre/coffre.js";
import { creerArtefacts, ErreurArtefact } from "./artefacts.js";
import { creerCoffreIdentifiants, creerPortS3Aws, creerStockage, ErreurStockage, type IdentifiantsS3, type PortS3, type RegistreReferences } from "./stockage.js";

// Tests contre la VRAIE brique SeaweedFS, lancée par le test avec l'image et la commande du fragment compose du socle.
// Les droits par compartiment ne sont pas supposés : ils sont essayés (fiche T1A-11, pièges). Clés d'essai générées au lancement.
const racineDepot = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const compose = lireYaml(readFileSync(racineDepot("ops/socle/compose.stockage.yml"), "utf8")) as unknown as {
  services: { stockage: { image: string; command: string[]; environment: Record<string, string> } };
};
const SERVICE = compose.services.stockage;
const COMMUNS = ["exports", "factures", "suivi", "artefacts"];
const lances: string[] = [];
afterAll(() => { for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ } });

const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const sha = (o: Uint8Array) => createHash("sha256").update(o).digest("hex");
const octets = (t: string) => new TextEncoder().encode(t);
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ErreurStockage || e instanceof ErreurArtefact ? e.code : "autre"));

let conteneur = "";
let endpoint = "";
let admin: PortS3;
const A = randomUUID();
const B = randomUUID();

function coffreMemoire() {
  const valeurs = new Map<string, string>();
  const coffre: Pick<Coffre, "rangerIdentifiant" | "lireValeur"> = {
    async rangerIdentifiant(tenantId, _nom, valeur) {
      const reference = `bao:clients/${tenantId}/${randomUUID()}`;
      valeurs.set(reference, valeur);
      return reference;
    },
    async lireValeur(tenantId, reference) {
      if (!reference.startsWith(`bao:clients/${tenantId}/`)) throw new Error("reference_etrangere");
      return valeurs.get(reference)!;
    },
  };
  const refs = new Map<string, string>();
  const registre: RegistreReferences = {
    async lire(t) { return refs.get(t); },
    async poser(t, r) { if (refs.has(t)) throw new ErreurStockage("deja_cree"); refs.set(t, r); },
  };
  return { valeurs, refs, coffre, registre };
}
const memoire = coffreMemoire();
const stockage = () => creerStockage({ s3: admin, coffre: creerCoffreIdentifiants({ coffre: memoire.coffre, registre: memoire.registre }) });
const identifiantsDe = async (t: string): Promise<IdentifiantsS3> => JSON.parse(memoire.valeurs.get(memoire.refs.get(t)!)!) as IdentifiantsS3;

beforeAll(async () => {
  const cleAdmin = SERVICE.environment.AWS_ACCESS_KEY_ID!;
  const secretAdmin = `TEST-NE-PAS-UTILISER-${randomBytes(16).toString("hex")}`;
  conteneur = docker("run", "-d", "--rm", "-e", `AWS_ACCESS_KEY_ID=${cleAdmin}`, "-e", `AWS_SECRET_ACCESS_KEY=${secretAdmin}`, SERVICE.image, ...SERVICE.command);
  lances.push(conteneur);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", conteneur).split(" ")[0] ?? "";
  endpoint = `http://${ip}:8333`;
  admin = creerPortS3Aws({ endpoint, admin: { cleAcces: cleAdmin, secret: secretAdmin } });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${endpoint}/healthz`)).status === 200) {
        await admin.creerCompartiment("sonde");
        break;
      }
    } catch { /* démarrage */ }
    if (i > 90) throw new Error(`SeaweedFS de test non démarré : ${docker("logs", conteneur).split("\n").slice(-5).join(" | ")}`);
    await pause(1000);
  }
  execFileSync("bash", [racineDepot("ops/socle/stockage/initialiser.sh"), conteneur], { encoding: "utf8" });
}, 180_000);

describe("stockage S3 : brique réelle", () => {
  it("[A-061] initialiser.sh a créé les compartiments communs et peut être relancé sans erreur", async () => {
    execFileSync("bash", [racineDepot("ops/socle/stockage/initialiser.sh"), conteneur], { encoding: "utf8" });
    // Un compartiment absent répondrait NoSuchBucket (erreur) ; un compartiment présent répond « objet absent ».
    for (const commun of COMMUNS) {
      const plateforme = await admin.creerUtilisateur(commun);
      await pause(1000);
      expect(await admin.lire(plateforme, commun, "absent"), commun).toBeUndefined();
      await admin.supprimerUtilisateur(commun);
    }
  });

  it("[A-061] @isolation les identifiants du client A ne lisent ni n'écrivent dans cli-B", async () => {
    const s = stockage();
    await s.creerCompartimentClient(A);
    await s.creerCompartimentClient(B);
    await s.deposer(B, "secret.txt", octets("réservé à B"));
    await pause(1500);
    const idA = await identifiantsDe(A);
    expect(idA.compartiment).toBe(`cli-${A}`);
    expect(await code(admin.lire(idA, `cli-${B}`, "secret.txt"))).toBe("acces_refuse");
    expect(await code(admin.deposer(idA, `cli-${B}`, "intrus.txt", octets("x")))).toBe("acces_refuse");
    for (const commun of COMMUNS) {
      expect(await code(admin.lire(idA, commun, "x")), commun).toBe("acces_refuse");
      expect(await code(admin.deposer(idA, commun, "x", octets("x"))), commun).toBe("acces_refuse");
    }
    expect(await s.lire(A, "secret.txt")).toBeUndefined();
    expect(new TextDecoder().decode(await s.lire(B, "secret.txt"))).toBe("réservé à B");
    await s.deposer(A, "mien.txt", octets("à moi"));
    expect(new TextDecoder().decode(await s.lire(A, "mien.txt"))).toBe("à moi");
  });

  it("[A-061] @isolation un refus 403 de la brique, après lecture du coffre, sort en acces_refuse sans identifiant ni secret", async () => {
    const idA = await identifiantsDe(A);
    const refB = memoire.refs.get(B)!;
    // Étiquette du compartiment de B, clé et secret de A : la couche laisse passer l'étiquette, seule la brique refuse.
    const faux = creerStockage({
      s3: admin,
      coffre: { ranger: async () => {}, lire: async () => ({ ...idA, compartiment: `cli-${B}` }) },
    });
    const e = await faux.lire(B, "secret.txt").then(() => undefined, (x: unknown) => x);
    expect((e as ErreurStockage).code).toBe("acces_refuse");
    const t = JSON.stringify(e) + String((e as Error).message) + String((e as Error).stack);
    for (const secret of [idA.secret, idA.cleAcces, refB]) expect(t).not.toContain(secret);
  });

  it("[A-061] @isolation une lecture anonyme de n'importe quel compartiment est refusée", async () => {
    const s = stockage();
    await s.deposer(A, "prive.txt", octets("privé"));
    for (const c of [...COMMUNS, `cli-${A}`, `cli-${B}`, "inexistant"]) {
      for (const cle of ["x", "prive.txt"]) {
        const lecture = await fetch(`${endpoint}/${c}/${cle}`);
        expect([401, 403], `lecture ${c}/${cle}`).toContain(lecture.status);
        const ecriture = await fetch(`${endpoint}/${c}/${cle}`, { method: "PUT", body: "intrus" });
        expect([401, 403], `écriture ${c}/${cle}`).toContain(ecriture.status);
      }
      expect([401, 403], `liste ${c}`).toContain((await fetch(`${endpoint}/${c}/`)).status);
    }
    expect([401, 403]).toContain((await fetch(`${endpoint}/`)).status);
    expect(await code(admin.lire(undefined, `cli-${A}`, "prive.txt"))).toBe("acces_refuse");
    expect(await code(admin.deposer(undefined, `cli-${A}`, "intrus.txt", octets("intrus")))).toBe("acces_refuse");
  });

  it("[A-061] @isolation deux créations simultanées pour le même client : une seule réussit, un seul jeu d'identifiants fonctionne", async () => {
    const C = randomUUID();
    const local = coffreMemoire();
    const s = creerStockage({ s3: admin, coffre: creerCoffreIdentifiants({ coffre: local.coffre, registre: local.registre }) });
    const resultats = await Promise.all([code(s.creerCompartimentClient(C)), code(s.creerCompartimentClient(C)), code(s.creerCompartimentClient(C))]);
    expect(resultats.sort()).toEqual(["deja_cree", "deja_cree", "ok"]);
    expect(local.valeurs.size).toBe(1);
    await pause(1500);
    await s.deposer(C, "x", octets("ok"));
    expect(await s.lire(C, "x")).toEqual(octets("ok"));
  });

  it("[A-061] un artefact est rangé sous son empreinte SHA-256 ; un second dépôt identique ne crée rien ; un contenu différent sous la même clé est refusé", async () => {
    const service = await admin.creerUtilisateur("artefacts");
    await pause(1500);
    const art = creerArtefacts({ s3: admin, identifiants: service });
    const o = octets("module signé du lot 4");
    const h = sha(o);
    expect(await art.deposerArtefact(o)).toBe(h);
    expect(await art.deposerArtefact(o)).toBe(h);
    expect(await art.lireArtefact(h)).toEqual(o);
    // Immuable côté brique : une écriture conditionnelle sur une clé existante ne remplace rien.
    expect(await admin.deposerSiAbsent(service, "artefacts", h, octets("autre contenu"))).toBe(false);
    expect(await art.lireArtefact(h)).toEqual(o);
    // Un objet altéré par un tiers (administrateur) est signalé, jamais écrasé.
    const alteree = octets("altéré hors plateforme");
    await admin.deposer(service, "artefacts", h, alteree);
    expect(await code(art.deposerArtefact(o))).toBe("empreinte_occupee");
    expect(await admin.lire(service, "artefacts", h)).toEqual(alteree);
    expect(await code(art.lireArtefact(h))).toBe("empreinte_incorrecte");
  });

  it("[A-061] un lien signé valide ouvre l'objet, un lien expiré est refusé, un lien vers un autre compartiment est refusé", async () => {
    const s = stockage();
    await s.deposer(A, "lien.txt", octets("par lien"));
    const lien = await s.lienSigne(A, "lien.txt", 2);
    const tot = await fetch(lien);
    expect(tot.status).toBe(200);
    expect(await tot.text()).toBe("par lien");
    await pause(3500);
    expect((await fetch(lien)).status).toBe(403);
    const idA = await identifiantsDe(A);
    const etranger = await admin.signer(idA, `cli-${B}`, "secret.txt", 60);
    expect((await fetch(etranger)).status).toBe(403);
  });

  it("[A-061] un lien signé de plus de 15 minutes ne peut pas être créé", async () => {
    const s = stockage();
    expect(await code(s.lienSigne(A, "lien.txt", 901))).toBe("duree_invalide");
    expect(await code(s.lienSigne(A, "lien.txt", 900))).toBe("ok");
  });
}, 240_000);
