import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { creerStockage, ErreurStockage, type IdentifiantsS3, type PortS3 } from "./stockage.js";

const racine = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));

// Imitation S3 : un compartiment n'accepte que les identifiants créés pour lui, jamais d'accès anonyme.
export function imitationS3(horloge: { t: number } = { t: 1_000_000 }) {
  const compartiments = new Map<string, Map<string, Uint8Array>>();
  const proprietaire = new Map<string, string>();
  const droit = (id: IdentifiantsS3 | undefined, c: string) => {
    if (!id || proprietaire.get(id.cleAcces) !== c || !compartiments.has(c)) throw new Error("403");
  };
  const port: PortS3 = {
    async creerCompartiment(nom) { compartiments.set(nom, compartiments.get(nom) ?? new Map()); },
    async creerUtilisateur(c) {
      const id = { cleAcces: `TEST-NE-PAS-UTILISER-${randomUUID()}`, secret: `TEST-NE-PAS-UTILISER-${randomUUID()}`, compartiment: c };
      proprietaire.set(id.cleAcces, c);
      return id;
    },
    async deposer(id, c, cle, octets) { droit(id, c); compartiments.get(c)!.set(cle, octets); },
    async lire(id, c, cle) { droit(id, c); return compartiments.get(c)!.get(cle); },
    async signer(id, c, cle, secondes) { droit(id, c); return `https://s3.test/${c}/${cle}?exp=${horloge.t + secondes}`; },
  };
  const ouvrirLien = (lien: string) => {
    const u = new URL(lien);
    if (Number(u.searchParams.get("exp")) <= horloge.t) throw new Error("403 lien expiré");
    return compartiments.get(u.pathname.split("/")[1]!)?.get(u.pathname.split("/").slice(2).join("/"));
  };
  return { port, compartiments, ouvrirLien, horloge };
}

function coffreMemoire() {
  const m = new Map<string, { tenantId: string; id: IdentifiantsS3 }>();
  return {
    m,
    async ranger(tenantId: string, id: IdentifiantsS3) { m.set(`bao:clients/${tenantId}/${randomUUID()}`, { tenantId, id }); },
    async lire(tenantId: string) { return [...m.values()].find((e) => e.tenantId === tenantId)?.id; },
  };
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
