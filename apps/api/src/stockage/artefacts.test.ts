import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { creerArtefacts, ErreurArtefact } from "./artefacts.js";
import type { PortS3 } from "./stockage.js";

// Imitation S3 réduite au compartiment commun « artefacts ».
function imitationS3() {
  const compartiments = new Map<string, Map<string, Uint8Array>>();
  const port: PortS3 = {
    async creerCompartiment(nom) { compartiments.set(nom, compartiments.get(nom) ?? new Map()); },
    async creerUtilisateur(c) { return { cleAcces: "TEST-NE-PAS-UTILISER-a", secret: "TEST-NE-PAS-UTILISER-b", compartiment: c }; },
    async supprimerUtilisateur() {},
    async deposer(id, c, cle, o) { if (!id) throw new Error("403"); compartiments.get(c)!.set(cle, o); },
    async deposerSiAbsent(id, c, cle, o) {
      if (!id) throw new Error("403");
      if (compartiments.get(c)!.has(cle)) return false;
      compartiments.get(c)!.set(cle, o);
      return true;
    },
    async lire(id, c, cle) { if (!id) throw new Error("403"); return compartiments.get(c)!.get(cle); },
    async signer() { throw new Error("inutile"); },
  };
  return { port, compartiments };
}

const sha = (o: Uint8Array) => createHash("sha256").update(o).digest("hex");
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ErreurArtefact ? e.code : "autre"));

async function monter() {
  const im = imitationS3();
  await im.port.creerCompartiment("artefacts");
  const service = await im.port.creerUtilisateur("artefacts");
  const compteurs = { creations: 0, ecrasements: 0, lectures: 0 };
  const port: PortS3 = {
    ...im.port,
    deposer: async (...a: Parameters<PortS3["deposer"]>) => { compteurs.ecrasements++; return im.port.deposer(...a); },
    deposerSiAbsent: async (...a: Parameters<PortS3["deposerSiAbsent"]>) => {
      const cree = await im.port.deposerSiAbsent(...a);
      if (cree) compteurs.creations++;
      return cree;
    },
    lire: async (...a: Parameters<PortS3["lire"]>) => { compteurs.lectures++; return im.port.lire(...a); },
  };
  return { im, art: creerArtefacts({ s3: port, identifiants: service }), compteurs, service };
}

describe("artefacts adressés par empreinte", () => {
  it("[A-061] un artefact est rangé sous son empreinte SHA-256 ; un second dépôt identique ne crée rien", async () => {
    const { im, art, compteurs } = await monter();
    const o = new TextEncoder().encode("contenu signé");
    expect(await art.deposerArtefact(o)).toBe(sha(o));
    expect(await art.deposerArtefact(o)).toBe(sha(o));
    expect(compteurs.creations).toBe(1);
    expect([...im.compartiments.get("artefacts")!.keys()]).toEqual([sha(o)]);
  });

  it("[A-061] un objet altéré sous son empreinte est refusé (empreinte_occupee) et n'est jamais écrasé", async () => {
    const { im, art } = await monter();
    const o = new TextEncoder().encode("original");
    const h = await art.deposerArtefact(o);
    im.compartiments.get("artefacts")!.set(h, new TextEncoder().encode("altéré"));
    expect(await code(art.deposerArtefact(o))).toBe("empreinte_occupee");
    expect(im.compartiments.get("artefacts")!.get(h)).toEqual(new TextEncoder().encode("altéré"));
  });

  it("[A-061] lire un artefact vérifie l'empreinte : un objet non adressé par son contenu est refusé", async () => {
    const { im, art } = await monter();
    const o = new TextEncoder().encode("bon");
    const h = await art.deposerArtefact(o);
    expect(await art.lireArtefact(h)).toEqual(o);
    im.compartiments.get("artefacts")!.set(h, new TextEncoder().encode("mauvais"));
    expect(await code(art.lireArtefact(h))).toBe("empreinte_incorrecte");
  });

  it("[A-061] une empreinte mal formée ou une traversée de chemin est refusée à la lecture", async () => {
    const { art } = await monter();
    for (const h of ["", "../cli-x/y", "ABC", "a".repeat(63), "A".repeat(64), `${"a".repeat(64)}/x`]) {
      expect(await code(art.lireArtefact(h))).toBe("empreinte_invalide");
    }
  });

  it("[A-061] un artefact vide ou absent est signalé sans écriture", async () => {
    const { art, compteurs } = await monter();
    expect(await code(art.deposerArtefact(new Uint8Array()))).toBe("artefact_vide");
    expect(await code(art.lireArtefact("a".repeat(64)))).toBe("introuvable");
    expect(compteurs.creations + compteurs.ecrasements).toBe(0);
  });

  it("[A-061] l'écriture est conditionnelle côté brique : jamais d'écrasement, aucun dépôt sans condition", async () => {
    const { art, compteurs } = await monter();
    const o = new TextEncoder().encode("conditionnel");
    await art.deposerArtefact(o);
    await art.deposerArtefact(o);
    expect(compteurs.ecrasements).toBe(0);
    expect(compteurs.creations).toBe(1);
  });

  it("[A-061] pas d'oracle d'existence : même réponse pour un contenu nouveau ou déjà rangé, et aucune lecture avant l'écriture d'un contenu nouveau", async () => {
    const { art, compteurs } = await monter();
    const o = new TextEncoder().encode("test d'existence");
    const premier = await art.deposerArtefact(o);
    expect(compteurs.lectures).toBe(0);
    const second = await art.deposerArtefact(o);
    expect(second).toBe(premier);
    expect(typeof second).toBe("string");
  });

  it("[A-061] @isolation des identifiants d'un autre compartiment que « artefacts » sont refusés dès la création", async () => {
    const { im, service } = await monter();
    expect(() => creerArtefacts({ s3: im.port, identifiants: { ...service, compartiment: "cli-x" } })).toThrow(ErreurArtefact);
    try {
      creerArtefacts({ s3: im.port, identifiants: { ...service, compartiment: "exports" } });
    } catch (e) {
      expect((e as ErreurArtefact).code).toBe("identifiants_etrangers");
    }
  });
});
