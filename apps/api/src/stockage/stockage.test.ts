import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import type { Coffre } from "../coffre/coffre.js";
import { creerCoffreIdentifiants, creerStockage, ErreurStockage, type IdentifiantsS3, type PortS3, type RegistreReferences } from "./stockage.js";

const racine = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));
const texte = (chemin: string) => readFileSync(racine(chemin), "utf8");
const EMPREINTE_IMAGE = "sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8";

// Imitation S3 : un compartiment n'accepte que les identifiants créés pour lui (clé ET secret), jamais d'accès anonyme.
// Un utilisateur par compartiment : une seconde création est refusée, comme l'API IAM de la brique.
export function imitationS3(horloge: { t: number } = { t: 1_000_000 }) {
  const compartiments = new Map<string, Map<string, Uint8Array>>();
  const proprietaire = new Map<string, { compartiment: string; secret: string }>();
  const utilisateurs = new Map<string, string>();
  const droit = (id: IdentifiantsS3 | undefined, c: string) => {
    const p = id ? proprietaire.get(id.cleAcces) : undefined;
    if (!id || !p || p.compartiment !== c || p.secret !== id.secret || !compartiments.has(c)) throw new ErreurStockage("acces_refuse");
  };
  const port: PortS3 = {
    async creerCompartiment(nom) { compartiments.set(nom, compartiments.get(nom) ?? new Map()); },
    async creerUtilisateur(c) {
      if (utilisateurs.has(c)) throw new ErreurStockage("deja_cree");
      const id = { cleAcces: `TEST-NE-PAS-UTILISER-${randomUUID()}`, secret: `TEST-NE-PAS-UTILISER-${randomUUID()}`, compartiment: c };
      proprietaire.set(id.cleAcces, { compartiment: c, secret: id.secret });
      utilisateurs.set(c, id.cleAcces);
      return id;
    },
    async supprimerUtilisateur(c) {
      const cle = utilisateurs.get(c);
      if (cle) proprietaire.delete(cle);
      utilisateurs.delete(c);
    },
    async deposer(id, c, cle, octets) { droit(id, c); compartiments.get(c)!.set(cle, octets); },
    async deposerSiAbsent(id, c, cle, octets) {
      droit(id, c);
      if (compartiments.get(c)!.has(cle)) return false;
      compartiments.get(c)!.set(cle, octets);
      return true;
    },
    async lire(id, c, cle) { droit(id, c); return compartiments.get(c)!.get(cle); },
    async signer(id, c, cle, secondes) { droit(id, c); return `https://s3.test/${c}/${cle}?exp=${horloge.t + secondes}`; },
  };
  const ouvrirLien = (lien: string) => {
    const u = new URL(lien);
    if (Number(u.searchParams.get("exp")) <= horloge.t) throw new Error("403 lien expiré");
    return compartiments.get(u.pathname.split("/")[1]!)?.get(u.pathname.split("/").slice(2).join("/"));
  };
  return { port, compartiments, utilisateurs, ouvrirLien, horloge };
}

function coffreMemoire() {
  const m = new Map<string, { tenantId: string; id: IdentifiantsS3 }>();
  const etat = { echec: false, lectures: 0 };
  return {
    m,
    etat,
    async ranger(tenantId: string, id: IdentifiantsS3) {
      if (etat.echec) throw new Error("coffre_indisponible");
      m.set(`bao:clients/${tenantId}/${randomUUID()}`, { tenantId, id });
    },
    async lire(tenantId: string) { etat.lectures++; return [...m.values()].find((e) => e.tenantId === tenantId)?.id; },
  };
}

// Coffre T1A-06 imité : une valeur se lit par sa référence bao:clients/<client>/<uuid>, jamais par le client seul.
function coffreBao() {
  const valeurs = new Map<string, { nom: string; valeur: string }>();
  const lectures: string[] = [];
  const coffre: Pick<Coffre, "rangerIdentifiant" | "lireValeur"> = {
    async rangerIdentifiant(tenantId, nom, valeur) {
      const reference = `bao:clients/${tenantId}/${randomUUID()}`;
      valeurs.set(reference, { nom, valeur });
      return reference;
    },
    async lireValeur(tenantId, reference) {
      lectures.push(reference);
      if (!reference.startsWith(`bao:clients/${tenantId}/`)) throw new Error("reference_etrangere");
      return valeurs.get(reference)!.valeur;
    },
  };
  return { coffre, valeurs, lectures };
}

function registreMemoire() {
  const m = new Map<string, string>();
  const registre: RegistreReferences = {
    async lire(tenantId) { return m.get(tenantId); },
    async poser(tenantId, reference) {
      if (m.has(tenantId)) throw new ErreurStockage("deja_cree");
      m.set(tenantId, reference);
    },
  };
  return { m, registre };
}

const A = randomUUID();
const B = randomUUID();
let im: ReturnType<typeof imitationS3>;
let coffre: ReturnType<typeof coffreMemoire>;
let stockage: ReturnType<typeof creerStockage>;
beforeEach(() => {
  im = imitationS3();
  coffre = coffreMemoire();
  stockage = creerStockage({ s3: im.port, coffre });
});

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ErreurStockage ? e.code : "autre"));

describe("stockage S3 par client", () => {
  it("[C-522] l'ADR 0015 existe, date et sources citées, la brique retenue y est nommée", () => {
    const f = racine("docs/adr/0015-stockage-objets.md");
    expect(existsSync(f)).toBe(true);
    const t = readFileSync(f, "utf8");
    expect(t).toContain("2026-10-25");
    expect(t).toContain("raw.githubusercontent.com");
    expect(t).toContain("hub.docker.com");
    expect(t).toContain("SeaweedFS");
    expect(t).toContain("Apache-2.0");
  });

  it("[A-061] si le coffre échoue ET que la suppression de l'utilisateur échoue, l'échec est signalé (nettoyage_incomplet) sans identifiant dans l'erreur", async () => {
    coffre.etat.echec = true;
    im.port.supprimerUtilisateur = async () => { throw new Error("suppression_impossible"); };
    let erreur: unknown;
    try {
      await stockage.creerCompartimentClient(A);
    } catch (e) {
      erreur = e;
    }
    expect(erreur).toBeInstanceOf(ErreurStockage);
    expect((erreur as ErreurStockage).code).toBe("nettoyage_incomplet");
    const [cleAcces] = [...im.utilisateurs.values()];
    expect(cleAcces).toBeDefined();
    const t = JSON.stringify(erreur) + String((erreur as Error).message) + String((erreur as Error).stack);
    expect(t).not.toContain(cleAcces!);
  });

  it("[A-061] creerCompartimentClient crée cli-<id> et range des identifiants limités à ce compartiment", async () => {
    await stockage.creerCompartimentClient(A);
    expect(im.compartiments.has(`cli-${A}`)).toBe(true);
    const [e] = [...coffre.m.values()];
    expect(e?.tenantId).toBe(A);
    expect(e?.id.compartiment).toBe(`cli-${A}`);
  });

  it("[A-061] @isolation les identifiants du client A ne lisent ni n'écrivent dans cli-B", async () => {
    await stockage.creerCompartimentClient(A);
    await stockage.creerCompartimentClient(B);
    const idA = [...coffre.m.values()].find((e) => e.tenantId === A)!.id;
    await expect(im.port.deposer(idA, `cli-${B}`, "x", new Uint8Array([1]))).rejects.toThrow();
    await expect(im.port.lire(idA, `cli-${B}`, "x")).rejects.toThrow();
    await stockage.deposer(B, "secret.txt", new Uint8Array([9]));
    expect(await stockage.lire(A, "secret.txt")).toBeUndefined();
    expect(await stockage.lire(B, "secret.txt")).toEqual(new Uint8Array([9]));
  });

  it("[A-061] @isolation des identifiants rangés pour un autre compartiment sont refusés par la couche", async () => {
    await stockage.creerCompartimentClient(A);
    await stockage.creerCompartimentClient(B);
    const refA = [...coffre.m.entries()].find(([, e]) => e.tenantId === A)!;
    refA[1].id = [...coffre.m.values()].find((e) => e.tenantId === B)!.id;
    expect(await code(stockage.lire(A, "x"))).toBe("identifiants_etrangers");
    expect(await code(stockage.deposer(A, "x", new Uint8Array([1])))).toBe("identifiants_etrangers");
    expect(await code(stockage.lienSigne(A, "x", 60))).toBe("identifiants_etrangers");
  });

  it("[A-061] @isolation un client sans compartiment ne peut rien déposer, et un second appel ne remplace pas ses identifiants", async () => {
    expect(await code(stockage.deposer(A, "x", new Uint8Array([1])))).toBe("compartiment_absent");
    await stockage.creerCompartimentClient(A);
    expect(await code(stockage.creerCompartimentClient(A))).toBe("deja_cree");
    expect(coffre.m.size).toBe(1);
  });

  it("[A-061] @isolation un identifiant de client mal formé est refusé avant tout appel S3", async () => {
    for (const mauvais of ["", "../cli-x", `${A.toUpperCase()}`, `${A}/..`, "cli-" + A, "a".repeat(300)]) {
      expect(await code(stockage.creerCompartimentClient(mauvais))).toBe("tenant_invalide");
      expect(await code(stockage.lire(mauvais, "x"))).toBe("tenant_invalide");
    }
    expect(im.compartiments.size).toBe(0);
  });

  it("[A-061] la traversée de chemin dans la clé est refusée", async () => {
    await stockage.creerCompartimentClient(A);
    for (const cle of ["", "..", "../cli-b/x", "a/../b", "/abs", "a//b", "a\\b", "a%2e%2e/b", "a\0b", ".cache", "a/./b", "a b", "x".repeat(600)]) {
      expect(await code(stockage.deposer(A, cle, new Uint8Array([1])))).toBe("cle_invalide");
      expect(await code(stockage.lire(A, cle))).toBe("cle_invalide");
      expect(await code(stockage.lienSigne(A, cle, 60))).toBe("cle_invalide");
    }
    expect(im.compartiments.get(`cli-${A}`)!.size).toBe(0);
  });

  it("[A-061] @isolation une lecture anonyme de n'importe quel compartiment est refusée", async () => {
    await stockage.creerCompartimentClient(A);
    for (const c of ["exports", "factures", "suivi", "artefacts", `cli-${A}`]) {
      await im.port.creerCompartiment(c);
      await expect(im.port.lire(undefined, c, "x")).rejects.toThrow();
    }
  });

  it("[A-061] un lien signé de plus de 15 minutes, nul, négatif ou fractionnaire ne peut pas être créé", async () => {
    await stockage.creerCompartimentClient(A);
    for (const s of [901, 3600, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await code(stockage.lienSigne(A, "x", s))).toBe("duree_invalide");
    }
    expect(await code(stockage.lienSigne(A, "x", 900))).toBe("ok");
  });

  it("[A-061] un lien signé expiré est refusé", async () => {
    await stockage.creerCompartimentClient(A);
    await stockage.deposer(A, "x", new Uint8Array([7]));
    const lien = await stockage.lienSigne(A, "x", 60);
    expect(im.ouvrirLien(lien)).toEqual(new Uint8Array([7]));
    im.horloge.t += 61;
    expect(() => im.ouvrirLien(lien)).toThrow();
  });

  it("[A-061] aucune erreur ne laisse passer un identifiant ni un secret", async () => {
    await stockage.creerCompartimentClient(A);
    const id = [...coffre.m.values()][0]!.id;
    const e = await stockage.lienSigne(A, "../x", 60).catch((x: unknown) => x);
    const texte = JSON.stringify(e) + String((e as Error).message) + String((e as Error).stack);
    expect(texte).not.toContain(id.secret);
    expect(texte).not.toContain(id.cleAcces);
  });
});

describe("création atomique et refus de la brique", () => {
  it("[A-061] @isolation deux créations simultanées pour le même client : une seule réussit, un seul utilisateur, un seul jeu dans le coffre", async () => {
    const resultats = await Promise.all([code(stockage.creerCompartimentClient(A)), code(stockage.creerCompartimentClient(A)), code(stockage.creerCompartimentClient(A))]);
    expect(resultats.sort()).toEqual(["deja_cree", "deja_cree", "ok"]);
    expect(im.utilisateurs.size).toBe(1);
    expect(coffre.m.size).toBe(1);
  });

  it("[A-061] un échec du coffre après la création de l'utilisateur supprime l'utilisateur : aucune entrée orpheline, la création peut être refaite", async () => {
    coffre.etat.echec = true;
    await expect(stockage.creerCompartimentClient(A)).rejects.toThrow("coffre_indisponible");
    expect(im.utilisateurs.size).toBe(0);
    expect(coffre.m.size).toBe(0);
    coffre.etat.echec = false;
    await stockage.creerCompartimentClient(A);
    expect(im.utilisateurs.size).toBe(1);
    expect(coffre.m.size).toBe(1);
  });

  it("[A-061] @isolation un refus 403 de la brique, après lecture du coffre, sort en acces_refuse sans identifiant ni secret", async () => {
    await stockage.creerCompartimentClient(A);
    const entree = [...coffre.m.values()][0]!;
    const vrai = { ...entree.id };
    // L'étiquette de compartiment est la bonne : seule la brique peut refuser ce jeu (secret faux).
    entree.id = { ...vrai, secret: "TEST-NE-PAS-UTILISER-forge" };
    const appels = [
      () => stockage.lire(A, "x"),
      () => stockage.deposer(A, "x", new Uint8Array([1])),
      () => stockage.lienSigne(A, "x", 60),
    ];
    for (const appel of appels) {
      const avant = coffre.etat.lectures;
      const e = await appel().then(() => undefined, (x: unknown) => x);
      expect(coffre.etat.lectures).toBe(avant + 1);
      expect(e).toBeInstanceOf(ErreurStockage);
      expect((e as ErreurStockage).code).toBe("acces_refuse");
      const t = JSON.stringify(e) + String((e as Error).message) + String((e as Error).stack);
      for (const secret of [vrai.secret, vrai.cleAcces, "forge"]) expect(t).not.toContain(secret);
    }
  });
});

describe("identifiants S3 rangés dans le coffre par référence (T1A-06)", () => {
  const id = (tenantId: string): IdentifiantsS3 => ({ cleAcces: "TEST-NE-PAS-UTILISER-cle", secret: "TEST-NE-PAS-UTILISER-secret", compartiment: `cli-${tenantId}` });

  it("[A-061] le jeu est rangé dans le coffre ; le registre ne garde que la référence bao:clients/<client>/<uuid>", async () => {
    const bao = coffreBao();
    const reg = registreMemoire();
    const c = creerCoffreIdentifiants({ coffre: bao.coffre, registre: reg.registre });
    await c.ranger(A, id(A));
    const reference = reg.m.get(A)!;
    expect(reference).toMatch(new RegExp(`^bao:clients/${A}/[0-9a-f-]{36}$`));
    expect(bao.valeurs.get(reference)?.nom).toBe("stockage-s3");
    expect(JSON.stringify([...reg.m])).not.toContain("secret");
    expect(await c.lire(A)).toEqual(id(A));
    expect(bao.lectures).toEqual([reference]);
  });

  it("[A-061] sans référence connue, rien n'est lu dans le coffre", async () => {
    const bao = coffreBao();
    const c = creerCoffreIdentifiants({ coffre: bao.coffre, registre: registreMemoire().registre });
    expect(await c.lire(A)).toBeUndefined();
    expect(bao.lectures).toEqual([]);
  });

  it("[A-061] @isolation la référence d'un autre client est refusée par le coffre, sans rien livrer", async () => {
    const bao = coffreBao();
    const reg = registreMemoire();
    const c = creerCoffreIdentifiants({ coffre: bao.coffre, registre: reg.registre });
    await c.ranger(B, id(B));
    reg.m.set(A, reg.m.get(B)!);
    await expect(c.lire(A)).rejects.toThrow("reference_etrangere");
  });

  it("[A-061] une valeur illisible dans le coffre est refusée sans la recopier dans l'erreur", async () => {
    for (const valeur of ["pas du json", "{}", JSON.stringify({ cleAcces: 1, secret: "s", compartiment: "c" }), JSON.stringify({ cleAcces: "k", secret: "TEST-NE-PAS-UTILISER-sec" })]) {
      const bao = coffreBao();
      const reg = registreMemoire();
      const c = creerCoffreIdentifiants({ coffre: bao.coffre, registre: reg.registre });
      reg.m.set(A, await bao.coffre.rangerIdentifiant(A, "stockage-s3", valeur));
      const e = await c.lire(A).then(() => undefined, (x: unknown) => x);
      expect((e as ErreurStockage).code).toBe("identifiants_illisibles");
      expect(String((e as Error).message)).not.toContain("TEST-NE-PAS-UTILISER-sec");
    }
  });

  it("[A-061] de bout en bout : créer, déposer et lire avec des identifiants lus par référence", async () => {
    const bao = coffreBao();
    const reg = registreMemoire();
    const s = creerStockage({ s3: im.port, coffre: creerCoffreIdentifiants({ coffre: bao.coffre, registre: reg.registre }) });
    await s.creerCompartimentClient(A);
    await s.deposer(A, "a.txt", new Uint8Array([4]));
    expect(await s.lire(A, "a.txt")).toEqual(new Uint8Array([4]));
    expect(bao.valeurs.size).toBe(1);
    expect(await code(s.creerCompartimentClient(A))).toBe("deja_cree");
    expect(bao.valeurs.size).toBe(1);
  });
});

describe("brique SeaweedFS et ADR 0022", () => {
  it("[C-522] l'ADR 0022 existe, date et sources citées, image amont épinglée par empreinte", () => {
    const t = texte("docs/adr/0022-stockage-seaweedfs-adaptateur-s3.md");
    for (const attendu of ["2026-10-26", "hub.docker.com", "raw.githubusercontent.com", "SeaweedFS", "4.51", EMPREINTE_IMAGE, "Apache-2.0", "If-None-Match", "client-iam", "image dérivée"]) {
      expect(t, attendu).toContain(attendu);
    }
    expect(texte("docs/adr/README.md")).toContain("| 0022 |");
  });

  it("[C-522] ops/briques/stockage.json et le compose passent la garde des briques, licence Apache-2.0, non livrée", () => {
    const brique = JSON.parse(texte("ops/briques/stockage.json")) as Record<string, unknown>;
    expect(brique).toMatchObject({ nom: "stockage", image: "chrislusf/seaweedfs", version: "4.51", empreinte: EMPREINTE_IMAGE, licence: "Apache-2.0", livree: false, lieu: "local" });
    expect(brique).not.toHaveProperty("derivee");
    // La vraie garde, sur tous les fichiers de briques et tous les composes (elle sort en erreur au premier refus).
    expect(() => execFileSync("node", ["scripts/garde-briques.ts"], { cwd: racine("."), stdio: "pipe" })).not.toThrow();
  });

  it("[A-061] le service stockage : réseau interne seulement, aucun port, volume séparé, secret par variable et jamais en clair", () => {
    const doc = lireYaml(texte("ops/socle/compose.stockage.yml")) as unknown as { services: Record<string, Record<string, unknown>>; volumes: Record<string, unknown> };
    const s = doc.services.stockage!;
    expect(Object.keys(doc.services)).toEqual(["stockage"]);
    expect(s.image).toBe(`chrislusf/seaweedfs:4.51@${EMPREINTE_IMAGE}`);
    expect(s.networks).toEqual(["interne"]);
    expect(s).not.toHaveProperty("ports");
    expect(s).not.toHaveProperty("build");
    expect(s.volumes).toEqual(["stockage-donnees:/data"]);
    expect(Object.keys(doc.volumes)).toEqual(["stockage-donnees"]);
    const env = s.environment as Record<string, string>;
    expect(env.AWS_SECRET_ACCESS_KEY).toMatch(/^\$\{SOCLE_STOCKAGE_MOT_DE_PASSE:\?[^}]+\}$/);
    expect(s.command).toContain("-s3.iam.readOnly=false");
  });

  it("[A-061] initialiser.sh crée exports, factures, suivi et artefacts, vérifie leur présence et n'ouvre aucun accès anonyme", () => {
    const t = texte("ops/socle/stockage/initialiser.sh").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(t).toMatch(/for c in exports factures suivi artefacts/);
    expect(t).toContain("s3.bucket.create");
    expect(t).not.toMatch(/anonym|public-read|s3\.configure/i);
  });

  it("[A-061] la variable SOCLE_STOCKAGE_MOT_DE_PASSE est dans l'inventaire des secrets et la brique dans le document des lieux de données", () => {
    expect(texte("ops/secrets-inventaire.md")).toContain("`SOCLE_STOCKAGE_MOT_DE_PASSE`");
    expect(texte("docs/localisation-des-donnees.md")).toMatch(/\| `stockage` \|/);
  });
});
