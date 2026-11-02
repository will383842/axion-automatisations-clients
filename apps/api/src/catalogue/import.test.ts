import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { sbom } from "../../../../packages/sdk-module/src/emballage/sbom.ts";
import { manifesteJson } from "../../../../packages/sdk-module/src/emballage/manifeste-json.ts";
import { SignataireMemoire, signerArtefact, type Artefact } from "../../../../packages/sdk-module/src/emballage/signer.ts";
import { moduleExemple } from "../../../../packages/sdk-module/exemples/module-exemple.ts";
import { construireServeur } from "../serveur.js";
import { ErreurApi } from "../plugins/erreurs.js";
import type { IdentifiantsS3, PortS3 } from "../stockage/stockage.js";
import { creerImporteur, verifierRecette, type DepotCatalogue, type EntreeVersion, type VersionRangee } from "./importer.js";
import { creerRangement } from "./ranger.js";
import { LIMITES } from "./schema.js";
import { verifierArtefactImporte } from "./verifier-artefact.js";

// Données inventées : modules sans client réel, adresses en @exemple.fr, clés de test générées à chaque exécution.
const octets = (t: string) => new TextEncoder().encode(t);
const ID: IdentifiantsS3 = { cleAcces: "cle-essai", secret: "secret-essai", compartiment: "modules" };

type Entree = { nom: string; contenu: Uint8Array; type?: string };
// Écrit une archive tar (ustar) puis la compresse : permet aussi de fabriquer des archives piégées (type, doublon, chemin).
function tar(entrees: Entree[]): Uint8Array {
  const blocs: Uint8Array[] = [];
  for (const e of entrees) {
    const h = new Uint8Array(512);
    h.set(octets(e.nom).slice(0, 100), 0);
    h.set(octets("0000644\0"), 100);
    h.set(octets(`${e.contenu.length.toString(8).padStart(11, "0")}\0`), 124);
    h.set(octets("00000000000\0"), 136);
    h.fill(32, 148, 156);
    h[156] = (e.type ?? "0").charCodeAt(0);
    h.set(octets("ustar\0" + "00"), 257);
    h.set(octets(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `), 148);
    blocs.push(h, e.contenu, new Uint8Array((512 - (e.contenu.length % 512)) % 512));
  }
  blocs.push(new Uint8Array(1024));
  return Buffer.concat(blocs);
}
const archiver = (a: Artefact, extra: Entree[] = []) => gzipSync(tar([...Object.entries(a).map(([nom, contenu]) => ({ nom, contenu })), ...extra]));

function modeleSigne(code: string, o: { version?: string; licence?: string; signataire?: SignataireMemoire; marque?: string } = {}) {
  const signataire = o.signataire ?? new SignataireMemoire("cle-essai-1");
  const man = JSON.parse(manifesteJson({ ...moduleExemple, code, version: o.version ?? "1.0.0", paquet: `@axion-auto/${code}` })) as object;
  const fichiers: Artefact = {
    "module.js": octets(`export default 1; // ${o.marque ?? "a"}\n`),
    "manifest.json": octets(JSON.stringify(man)),
    "sbom.cdx.json": octets(JSON.stringify(sbom(code, o.version ?? "1.0.0", o.licence ? [{ nom: "lib-essai", version: "1.0.0", licence: o.licence }] : []))),
  };
  return { signataire, cles: [{ idCle: "cle-essai-1", publique: signataire.clePublique }], artefact: signerArtefact(fichiers, signataire) };
}

class S3Memoire implements PortS3 {
  objets = new Map<string, Uint8Array>();
  deposerAppele = 0;
  async creerCompartiment() {}
  async creerUtilisateur(): Promise<IdentifiantsS3> { return ID; }
  async supprimerUtilisateur() {}
  async deposer() { this.deposerAppele++; }
  async deposerSiAbsent(_i: IdentifiantsS3 | undefined, _c: string, cle: string, o: Uint8Array) {
    if (this.objets.has(cle)) return false;
    this.objets.set(cle, o);
    return true;
  }
  async lire(_i: IdentifiantsS3 | undefined, _c: string, cle: string) { return this.objets.get(cle); }
  async signer() { return ""; }
}

class DepotMemoire implements DepotCatalogue {
  versions: (VersionRangee & { automatisation: string })[] = [];
  automatisations = new Set<string>();
  async enregistrer(e: EntreeVersion) {
    await Promise.resolve();
    const existante = this.versions.find((v) => (v.automatisation === e.codeAutomatisation && v.semver === e.semver) || v.empreinte === e.empreinte);
    if (existante) return { cree: false as const, version: existante };
    this.automatisations.add(e.codeAutomatisation);
    const version = { automatisation: e.codeAutomatisation, semver: e.semver, empreinte: e.empreinte, statut: "brouillon" as const, ref: e.ref };
    this.versions.push(version);
    return { cree: true as const, version };
  }
}

function monter(o: { ouvert?: boolean; doublons?: (nom: string) => Promise<string[]> } = {}) {
  const s3 = new S3Memoire();
  const depot = new DepotMemoire();
  const signataire = new SignataireMemoire("cle-essai-1");
  const cles = [{ idCle: "cle-essai-1", publique: signataire.clePublique }];
  const importeur = creerImporteur({ cles, rangement: creerRangement({ s3, identifiants: ID }), depot, ...(o.doublons ? { doublons: o.doublons } : {}) });
  const serveur = construireServeur({
    importCatalogue: {
      ouvert: o.ouvert ?? true,
      importeur,
      authentifier: async (r) => {
        if (r.headers["x-test-acteur"] !== "equipe") throw new ErreurApi("action_interdite", "Réservé à l'équipe.");
        return { acteur: "equipe-essai" };
      },
    },
  });
  const poster = (archive: Uint8Array, code = "ACC-001", entetes: Record<string, string> = {}) =>
    serveur.inject({ method: "POST", url: "/api/catalogue/v1/versions", payload: Buffer.from(archive), headers: { "content-type": "application/gzip", "x-test-acteur": "equipe", "x-automatisation": code, ...entetes } });
  return { s3, depot, signataire, cles, importeur, serveur, poster };
}
const signeAvec = (m: ReturnType<typeof monter>, code: string, o: { version?: string; licence?: string; marque?: string } = {}) => modeleSigne(code, { ...o, signataire: m.signataire }).artefact;

describe("vérification de l'artefact par la console", () => {
  it("[C-248] un artefact dont le SBOM contient une licence AGPL est refusé par la console même si le poste l'a accepté", () => {
    const m = modeleSigne("module-agpl", { licence: "AGPL-3.0-only" });
    const r = verifierArtefactImporte(archiver(m.artefact), m.cles);
    expect(r).toEqual({ ok: false, code: "licence_non_permise" });
  });

  it("[C-248] une signature d'une clé inconnue est refusée", () => {
    const m = modeleSigne("module-cle-inconnue");
    const autre = new SignataireMemoire("autre-cle");
    expect(verifierArtefactImporte(archiver(m.artefact), [{ idCle: "autre-cle", publique: autre.clePublique }])).toEqual({ ok: false, code: "module_non_signe" });
  });

  it("[C-248] un octet changé après la signature est refusé", () => {
    const m = modeleSigne("module-altere");
    m.artefact["module.js"] = octets("export default 2;\n");
    expect(verifierArtefactImporte(archiver(m.artefact), m.cles)).toEqual({ ok: false, code: "module_non_signe" });
  });

  it("[C-248] un manifeste hors schéma est refusé même signé", () => {
    const m = modeleSigne("module-manifeste");
    const hors = signerArtefact({ "module.js": m.artefact["module.js"] as Uint8Array, "manifest.json": octets('{"code":"X"}'), "sbom.cdx.json": m.artefact["sbom.cdx.json"] as Uint8Array }, m.signataire);
    expect(verifierArtefactImporte(archiver(hors), m.cles)).toEqual({ ok: false, code: "manifeste_invalide" });
  });

  it("[C-248] un secret en dur dans module.js est refusé même signé", () => {
    const m = modeleSigne("module-secret");
    const secret = signerArtefact({ "module.js": octets(`export const k = "${"AKIA"}${"A".repeat(16)}";`), "manifest.json": m.artefact["manifest.json"] as Uint8Array, "sbom.cdx.json": m.artefact["sbom.cdx.json"] as Uint8Array }, m.signataire);
    expect(verifierArtefactImporte(archiver(secret), m.cles)).toEqual({ ok: false, code: "contenu_interdit" });
  });

  it("[C-248] une archive piégée est refusée (chemin ../, lien symbolique, fichier en double, fichier inconnu)", () => {
    const m = modeleSigne("module-piege");
    const les = (extra: Entree[], sans: string[] = []) => archiver(Object.fromEntries(Object.entries(m.artefact).filter(([k]) => !sans.includes(k))), extra);
    const un = octets("x");
    for (const a of [
      les([{ nom: "../evasion.js", contenu: un }]),
      les([{ nom: "module.js", contenu: un }]),
      les([{ nom: "lien.js", contenu: new Uint8Array(0), type: "2" }]),
      les([{ nom: "/etc/passwd", contenu: un }]),
      les([{ nom: "autre.txt", contenu: un }]),
    ]) expect(verifierArtefactImporte(a, m.cles)).toEqual({ ok: false, code: "archive_invalide" });
    expect(verifierArtefactImporte(gzipSync(octets("pas une archive")), m.cles)).toEqual({ ok: false, code: "archive_invalide" });
  });

  it("[C-248] une bombe de décompression est refusée sans remplir la mémoire", () => {
    const m = modeleSigne("module-bombe");
    const gros = new Uint8Array(LIMITES.decompresseOctets + 1024);
    const bombe = gzipSync(tar([{ nom: "module.js", contenu: gros }]), { level: 1 });
    expect(bombe.length).toBeLessThan(LIMITES.archiveOctets);
    expect(verifierArtefactImporte(bombe, m.cles)).toEqual({ ok: false, code: "archive_invalide" });
  });
});

describe("rangement adressé par empreinte", () => {
  it("[A-304] la version est rangée sous son empreinte et relue identique", async () => {
    const m = monter();
    const rep = await m.poster(archiver(signeAvec(m, "module-range")));
    expect(rep.statusCode).toBe(201);
    const { version } = rep.json() as { version: { empreinte: string; statut: string } };
    expect(version.empreinte).toMatch(/^[0-9a-f]{64}$/);
    const relu = await creerRangement({ s3: m.s3, identifiants: ID }).lire(version.empreinte);
    const attendu = signeAvec(m, "module-range");
    expect(Object.keys(relu).sort()).toEqual(Object.keys(attendu).sort());
    for (const [nom, contenu] of Object.entries(attendu)) expect(Buffer.from(relu[nom] as Uint8Array).equals(Buffer.from(contenu))).toBe(true);
    expect([...m.s3.objets.keys()].every((c) => c.startsWith(`modules/${version.empreinte}/`))).toBe(true);
    expect(m.s3.deposerAppele).toBe(0);
  });

  it("[A-304] un objet déjà en place sous la même clé avec un autre contenu fait échouer le rangement", async () => {
    const m = monter();
    const a = modeleSigne("module-occupe", { signataire: m.signataire });
    const importeur = creerRangement({ s3: m.s3, identifiants: ID });
    const r = verifierArtefactImporte(archiver(a.artefact), m.cles);
    if (!r.ok) throw new Error("attendu : valide");
    m.s3.objets.set(`modules/${r.empreinte}/module.js`, octets("autre contenu"));
    await expect(importeur.ranger(r.empreinte, r.fichiers)).rejects.toThrow("empreinte_occupee");
  });

  it("[A-407] la même version avec un autre contenu est refusée (409)", async () => {
    const m = monter();
    expect((await m.poster(archiver(signeAvec(m, "module-conflit", { marque: "un" })))).statusCode).toBe(201);
    const rep = await m.poster(archiver(signeAvec(m, "module-conflit", { marque: "deux" })));
    expect(rep.statusCode).toBe(409);
    expect((rep.json() as { erreur: { code: string } }).erreur.code).toBe("identifiant_deja_pris");
    expect(m.depot.versions).toHaveLength(1);
  });

  it("[A-407] deux imports simultanés de la même version avec deux contenus : un seul gagne", async () => {
    const m = monter();
    const [a, b] = await Promise.all([m.poster(archiver(signeAvec(m, "module-course", { marque: "un" }))), m.poster(archiver(signeAvec(m, "module-course", { marque: "deux" })))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(m.depot.versions).toHaveLength(1);
  });

  it("[A-407] réimporter la même version avec la même empreinte répond à l'identique", async () => {
    const m = monter();
    const archive = archiver(signeAvec(m, "module-idempotent"));
    const premiere = await m.poster(archive);
    const seconde = await m.poster(archive);
    expect([premiere.statusCode, seconde.statusCode]).toEqual([201, 200]);
    expect((seconde.json() as { version: unknown }).version).toEqual((premiere.json() as { version: unknown }).version);
    expect(m.depot.versions).toHaveLength(1);
  });

  it("[A-407] aucune route ne supprime ni ne remplace une version", async () => {
    const m = monter();
    await m.serveur.ready();
    for (const methode of ["DELETE", "PUT", "PATCH"] as const) {
      for (const url of ["/api/catalogue/v1/versions", "/api/catalogue/v1/versions/1.0.0"]) {
        const rep = await m.serveur.inject({ method: methode, url, headers: { "x-test-acteur": "equipe" } });
        expect(rep.statusCode, `${methode} ${url}`).toBe(404);
      }
    }
    const routes = m.serveur.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/DELETE|PUT|PATCH/);
  });

  it("[A-407] le code ne contient aucune écriture qui écrase ni aucune évaluation du module", () => {
    for (const f of ["importer", "verifier-artefact", "ranger", "schema"]) {
      const source = readFileSync(new URL(`./${f}.ts`, import.meta.url), "utf8");
      expect(source, f).not.toMatch(/\bimport\s*\(|\beval\s*\(|new Function|node:vm|node:child_process|\.deposer\(/);
    }
  });
});

describe("import dans la console", () => {
  it("[A-024] la version importée est en état brouillon", async () => {
    const m = monter();
    const rep = await m.poster(archiver(signeAvec(m, "module-brouillon")), "ACC-002", { "x-statut": "publiee" });
    expect(rep.statusCode).toBe(201);
    expect((rep.json() as { version: { statut: string } }).version.statut).toBe("brouillon");
    expect(m.depot.versions[0]?.statut).toBe("brouillon");
  });

  it("[A-034] trois modules neufs s'importent sans changement de la console", async () => {
    const m = monter();
    for (const [i, code] of ["modele-un", "modele-deux", "modele-trois"].entries()) {
      const rep = await m.poster(archiver(signeAvec(m, code)), `MOD-00${i + 1}`);
      expect(rep.statusCode, code).toBe(201);
    }
    expect(m.depot.versions.map((v) => v.automatisation)).toEqual(["MOD-001", "MOD-002", "MOD-003"]);
  });

  it("[B-534] importer une automatisation proche d'une existante montre le signal et l'import continue", async () => {
    const m = monter({ doublons: async () => ["ACC-001"] });
    const rep = await m.poster(archiver(signeAvec(m, "module-proche")), "ACC-009");
    expect(rep.statusCode).toBe(201);
    expect((rep.json() as { signal_doublon: string[] }).signal_doublon).toEqual(["ACC-001"]);
  });

  it("[B-534] un service des doublons en panne ne bloque pas l'import", async () => {
    const m = monter({ doublons: async () => { throw new Error("panne"); } });
    const rep = await m.poster(archiver(signeAvec(m, "module-sans-signal")), "ACC-010");
    expect(rep.statusCode).toBe(201);
    expect((rep.json() as { signal_doublon: string[] }).signal_doublon).toEqual([]);
  });

  it("[C-248] l'interrupteur IMPORT_OUVERT fermé répond 503 sans rien ranger", async () => {
    const m = monter({ ouvert: false });
    const rep = await m.poster(archiver(signeAvec(m, "module-ferme")));
    expect(rep.statusCode).toBe(503);
    expect(m.s3.objets.size).toBe(0);
  });

  it("[C-248] sans équipe authentifiée, 403 et rien n'est rangé", async () => {
    const m = monter();
    const rep = await m.poster(archiver(signeAvec(m, "module-anonyme")), "ACC-001", { "x-test-acteur": "inconnu" });
    expect(rep.statusCode).toBe(403);
    expect(m.s3.objets.size).toBe(0);
  });

  it("[C-248] un code d'automatisation mal formé est refusé (400)", async () => {
    const m = monter();
    expect((await m.poster(archiver(signeAvec(m, "module-code")), "pas-un-code")).statusCode).toBe(400);
  });

  it("[C-248] une archive de plus de 20 Mo est refusée (413)", async () => {
    const m = monter();
    const rep = await m.poster(new Uint8Array(LIMITES.archiveOctets + 1));
    expect(rep.statusCode).toBe(413);
  });
});

describe("import par la clé de la recette", () => {
  const cle = octets("cle-recette-essai");
  const signer = (corps: Uint8Array, t: number) => createHmac("sha256", cle).update(`${t}\n${createHash("sha256").update(corps).digest("hex")}`).digest("hex");
  const maintenant = 1_800_000_000;

  it("[C-248] une signature HMAC valide est acceptée, un corps changé est refusé", () => {
    const corps = octets("archive");
    const ok = { "x-axion-horodatage": String(maintenant), "x-axion-signature": signer(corps, maintenant) };
    expect(verifierRecette({ cle, maintenant: () => maintenant }, ok, corps)).toBe(true);
    expect(verifierRecette({ cle, maintenant: () => maintenant }, ok, octets("autre"))).toBe(false);
  });

  it("[C-248] une signature trop ancienne ou absente est refusée", () => {
    const corps = octets("archive");
    const vieux = maintenant - 3600;
    expect(verifierRecette({ cle, maintenant: () => maintenant }, { "x-axion-horodatage": String(vieux), "x-axion-signature": signer(corps, vieux) }, corps)).toBe(false);
    expect(verifierRecette({ cle, maintenant: () => maintenant }, {}, corps)).toBe(false);
  });

  it("[A-024] un import par la recette ne peut viser qu'un état brouillon", async () => {
    const m = monter();
    const rep = await m.poster(archiver(signeAvec(m, "module-recette")), "REC-001", { "x-statut": "pilote" });
    expect((rep.json() as { version: { statut: string } }).version.statut).toBe("brouillon");
  });
});
