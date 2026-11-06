import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HorlogeFactice } from "../noyau/horloge.ts";
import { deposer } from "./deposer.ts";
import { balayerChaqueHeure, DUREE_TRANSIT_MS, expirer } from "./expirer.ts";
import { lire } from "./lire.ts";
import type { Chiffreur, PortTransit } from "./port.ts";

const CLIENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MARQUEUR = "PJ-MARQUEUR-UNIQUE-7f3a91c2";
const MIN = 60_000;
const H = 60 * MIN;

// Chiffreur d'essai : AES-256-GCM avec une clé par client et le contexte en données associées, comme le coffre.
function chiffreurEssai(): Chiffreur & { cles: Map<string, Buffer> } {
  const cles = new Map<string, Buffer>();
  const cle = (t: string) => cles.get(t) ?? cles.set(t, randomBytes(32)).get(t)!;
  return {
    cles,
    async chiffrer(t, octets, contexte) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", cle(t), iv);
      c.setAAD(Buffer.from(`${t}|${contexte}`));
      return { chiffre: Buffer.concat([iv, c.update(octets), c.final(), c.getAuthTag()]), cleChiffree: "vault:v1:AAAA", version: 1 };
    },
    async dechiffrer(t, e, contexte) {
      const d = createDecipheriv("aes-256-gcm", cle(t), e.chiffre.subarray(0, 12));
      d.setAAD(Buffer.from(`${t}|${contexte}`));
      d.setAuthTag(e.chiffre.subarray(e.chiffre.length - 16));
      return Buffer.concat([d.update(e.chiffre.subarray(12, e.chiffre.length - 16)), d.final()]);
    },
  };
}

// Stockage d'essai SANS règle de cycle de vie : il ne périme rien tout seul.
function stockageEssai(horloge: HorlogeFactice) {
  const objets = new Map<string, { octets: Uint8Array; ecritLe: number }>();
  const port: PortTransit = {
    async ecrire(cle, octets) {
      objets.set(cle, { octets, ecritLe: horloge.maintenant() });
    },
    async lire(cle) {
      return objets.get(cle);
    },
    async lister() {
      return [...objets].map(([cle, o]) => ({ cle, ecritLe: o.ecritLe }));
    },
    async supprimer(cle) {
      objets.delete(cle);
    },
  };
  return { port, objets };
}

const contenu = () => Buffer.from(`facture ${MARQUEUR}`);

describe("pièces jointes en transit", () => {
  it("[A-371] la copie déposée est chiffrée (octets relus dans le stockage illisibles sans la clé)", async () => {
    const h = new HorlogeFactice();
    const { port, objets } = stockageEssai(h);
    const chiffreur = chiffreurEssai();
    const ref = await deposer({ port, chiffreur, horloge: h }, CLIENT_A, contenu());
    const brut = Buffer.concat([...objets.values()].map((o) => Buffer.from(o.octets)));
    expect(brut.includes(MARQUEUR)).toBe(false);
    expect(ref).not.toMatch(/^https?:/);
    expect(await lire({ port, chiffreur, horloge: h }, ref, CLIENT_A)).toEqual(contenu());
    // la clé d'un autre client ne lit rien
    const autre = chiffreurEssai();
    await expect(lire({ port, chiffreur: autre, horloge: h }, ref, CLIENT_A)).rejects.toThrow("transit_illisible");
  });

  it("[A-371] @isolation une référence du client A lue pour B est refusée", async () => {
    const h = new HorlogeFactice();
    const { port } = stockageEssai(h);
    const chiffreur = chiffreurEssai();
    const dep = { port, chiffreur, horloge: h };
    const ref = await deposer(dep, CLIENT_A, contenu());
    const lireSpy = vi.spyOn(port, "lire");
    await expect(lire(dep, ref, CLIENT_B)).rejects.toThrow("reference_refusee");
    // le stockage n'est même pas interrogé pour une référence d'un autre client
    expect(lireSpy).not.toHaveBeenCalled();
    // références devinées : préfixe seul, nom non aléatoire, chemin remonté, autre forme
    for (const devinee of [`${CLIENT_A}/`, `${CLIENT_A}/1`, `${CLIENT_A}/../${CLIENT_B}/x`, CLIENT_A, "", `${CLIENT_A}/${"0".repeat(64)}`]) {
      await expect(lire(dep, devinee, CLIENT_A)).rejects.toThrow(/reference_refusee|transit_absent/);
    }
    // deux dépôts identiques donnent deux références aléatoires distinctes
    expect(await deposer(dep, CLIENT_A, contenu())).not.toBe(ref);
  });

  it("[C-023] une copie de 24 h et 1 min n'est plus lisible", async () => {
    const h = new HorlogeFactice();
    const { port } = stockageEssai(h);
    const dep = { port, chiffreur: chiffreurEssai(), horloge: h };
    const ref = await deposer(dep, CLIENT_A, contenu());
    expect(DUREE_TRANSIT_MS).toBe(24 * H);
    h.regler(h.maintenant() + 24 * H - MIN);
    expect(await lire(dep, ref, CLIENT_A)).toEqual(contenu());
    h.regler(h.maintenant() + 2 * MIN);
    await expect(lire(dep, ref, CLIENT_A)).rejects.toThrow("transit_expire");
  });

  it("[C-023] la règle d'expiration retirée, le balayage horaire efface quand même", async () => {
    const h = new HorlogeFactice();
    const { port, objets } = stockageEssai(h); // aucune règle de cycle de vie
    const dep = { port, chiffreur: chiffreurEssai(), horloge: h };
    await deposer(dep, CLIENT_A, contenu());
    h.regler(h.maintenant() + 23 * H);
    await deposer(dep, CLIENT_B, contenu());
    h.regler(h.maintenant() + 2 * H); // A a 25 h, B a 2 h
    expect(await expirer({ port, horloge: h })).toBe(1);
    expect([...objets.keys()].every((k) => k.startsWith(`${CLIENT_B}/`))).toBe(true);
    expect(objets.size).toBe(1);
  });

  it("[C-023] le balayage tourne chaque heure et survit à une panne du stockage", async () => {
    const h = new HorlogeFactice();
    const { port, objets } = stockageEssai(h);
    const dep = { port, chiffreur: chiffreurEssai(), horloge: h };
    await deposer(dep, CLIENT_A, contenu());
    const sauf = port.lister.bind(port);
    let appels = 0;
    port.lister = async () => {
      if (++appels === 1) throw new Error("panne");
      return sauf();
    };
    const arret = new AbortController();
    const boucle = balayerChaqueHeure({ port, horloge: h }, arret.signal);
    h.regler(h.maintenant() + 25 * H);
    // trois tours d'une heure : la panne du premier n'arrête pas les suivants
    const pilote = h.piloter(
      (async () => {
        while (appels < 3) await new Promise((r) => setImmediate(r));
        arret.abort();
      })(),
    );
    await pilote;
    await boucle;
    expect(appels).toBeGreaterThanOrEqual(3);
    expect(objets.size).toBe(0);
  });

  it("[C-023] aucun octet de la pièce jointe n'existe dans la base moteur ni dans les journaux (marqueur unique)", async () => {
    const h = new HorlogeFactice();
    const { port } = stockageEssai(h);
    const sorties: string[] = [];
    const espions = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void sorties.push(a.map(String).join(" "))));
    const erreurs: string[] = [];
    try {
      // un stockage qui échoue avec le contenu dans son message : l'erreur sortante ne le recopie pas
      const casse: PortTransit = { ...port, ecrire: async (_c, octets) => Promise.reject(new Error(`échec ${Buffer.from(octets).toString("latin1")} ${MARQUEUR}`)) };
      await deposer({ port: casse, chiffreur: chiffreurEssai(), horloge: h }, CLIENT_A, contenu()).catch((e: Error) => erreurs.push(String(e.message), String(e.stack), JSON.stringify(e)));
      const chiffreurCasse: Chiffreur = { chiffrer: async () => Promise.reject(new Error(MARQUEUR)), dechiffrer: async () => Promise.reject(new Error(MARQUEUR)) };
      await deposer({ port, chiffreur: chiffreurCasse, horloge: h }, CLIENT_A, contenu()).catch((e: Error) => erreurs.push(String(e.message), String(e.stack)));
    } finally {
      espions.forEach((e) => e.mockRestore());
    }
    expect(erreurs.length).toBeGreaterThan(0);
    expect([...sorties, ...erreurs].join("\n")).not.toContain(MARQUEUR);
    expect(erreurs.join("\n")).toContain("transit_indisponible");
  });
});
