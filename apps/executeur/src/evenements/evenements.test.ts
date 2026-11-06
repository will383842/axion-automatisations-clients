import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Paquet, type Evenement } from "@axion-auto/contrats/src/c4/evenements-executeur.ts";
import { EN_TETES, signer } from "@axion-auto/contrats/src/commun/signature.ts";
import { construireFin, EnvoiEvenements } from "./envoi.ts";
import { TamponEvenements } from "./tampon.ts";

const dossiers: string[] = [];
const dossier = () => (dossiers.push(mkdtempSync(join(tmpdir(), "tampon-"))), dossiers.at(-1)!);
afterEach(() => dossiers.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const A = "2026-11-06T10:00:00.000Z";
const debut = (i: number): Evenement => ({ type: "debut", instanceId: "inst-1", executionId: `exec-${i}`, a: A });

function envoi(d: string, o: { statuts?: number[]; max?: number } = {}) {
  const paquets: { corps: string; cle: string; horodatage: string; signature: string; idem: string }[] = [];
  const statuts = [...(o.statuts ?? [])];
  const faux = (async (_u: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    paquets.push({ corps: init.body as string, cle: h[EN_TETES.cle]!, horodatage: h[EN_TETES.horodatage]!, signature: h[EN_TETES.signature]!, idem: h[EN_TETES.idempotence]! });
    return new Response("", { status: statuts.shift() ?? 202 });
  }) as unknown as typeof fetch;
  const tampon = new TamponEvenements(d, { maxEvenements: o.max ?? 100_000 });
  const e = new EnvoiEvenements({ tampon, url: "http://console.test", cle: "c4:auto-run-1:1", secret: () => "secret-de-test", fetch: faux, maintenant: () => 1_700_000_000, dormir: async () => undefined, celluleId: "auto-run-1", instancesActives: () => ["inst-1", "inst-2"] });
  return { e, paquets, tampon };
}

describe("événements d'exécution : envoi par paquets", () => {
  it("[A-343] une exécution produit debut puis fin, ou debut puis erreur", async () => {
    const { e, paquets } = envoi(dossier());
    await e.envoyer(debut(1));
    await e.envoyer({ type: "fin", ...construireFin({ instanceId: "inst-1", executionId: "exec-1", dureeMs: 900, elements: 3, minutesGagneesParElement: 5, jetons: 10, coutIaMicroCentimes: 7 }) } as Evenement);
    await e.envoyer({ ...debut(2) });
    await e.envoyer({ type: "erreur", instanceId: "inst-1", executionId: "exec-2", classe: "passagere", code: "reseau" });
    await e.vider();
    const types = paquets.flatMap((p) => (JSON.parse(p.corps) as Paquet).evenements.map((x) => `${x.type}:${"executionId" in x ? x.executionId : ""}`));
    expect(types).toEqual(["debut:exec-1", "fin:exec-1", "debut:exec-2", "erreur:exec-2"]);
  });

  it("[A-344] 1 200 événements partent en 3 paquets au plus, chacun valide et signé", async () => {
    const { e, paquets } = envoi(dossier());
    for (let i = 0; i < 1200; i++) await e.envoyer(debut(i));
    await e.vider();
    expect(paquets).toHaveLength(3);
    for (const p of paquets) {
      expect(Paquet.safeParse(JSON.parse(p.corps)).success).toBe(true);
      expect(p.signature).toBe(signer("secret-de-test", p.horodatage, "POST", "/api/executeur/v1/evenements", p.corps));
    }
    expect(new Set(paquets.map((p) => p.idem)).size).toBe(3);
  });

  it("[A-344] le tampon survit à un redémarrage de la cellule", async () => {
    const d = dossier();
    const un = new TamponEvenements(d, { maxEvenements: 1000 });
    un.ajouter(debut(1));
    un.ajouter(debut(2));
    const deux = new TamponEvenements(d, { maxEvenements: 1000 });
    expect(deux.evenements().map((x) => (x as { executionId: string }).executionId)).toEqual(["exec-1", "exec-2"]);
    deux.retirer(2);
    expect(new TamponEvenements(d, { maxEvenements: 1000 }).evenements()).toHaveLength(0);
  });

  it("[A-344] le tampon est borné : au-delà, l'ajout est refusé et compté, rien n'est effacé", () => {
    const t = new TamponEvenements(dossier(), { maxEvenements: 3 });
    expect([1, 2, 3, 4, 5].map((i) => t.ajouter(debut(i)))).toEqual([true, true, true, false, false]);
    expect(t.refuses).toBe(2);
    expect(t.evenements()).toHaveLength(3);
  });

  it("[A-343] un paquet refusé (503) est gardé et renvoyé avec la même clé d'idempotence, re-signé", async () => {
    const d = dossier();
    const { e, paquets, tampon } = envoi(d, { statuts: [503] });
    await e.envoyer(debut(1));
    await e.vider();
    expect(paquets).toHaveLength(2);
    expect(paquets[1]!.idem).toBe(paquets[0]!.idem);
    expect(paquets[1]!.horodatage).not.toBe(paquets[0]!.horodatage);
    expect(paquets[1]!.signature).not.toBe(paquets[0]!.signature);
    expect(tampon.evenements()).toHaveLength(0);
  });

  it("[A-343] un refus définitif (400) garde les événements dans le tampon, sans les perdre", async () => {
    const { e, tampon } = envoi(dossier(), { statuts: [400] });
    await e.envoyer(debut(1));
    await expect(e.vider()).rejects.toThrow();
    expect(tampon.evenements()).toHaveLength(1);
  });

  it("[A-344] le signal de vie nomme la cellule et ses instances actives, sans texte libre", async () => {
    const { e, paquets } = envoi(dossier());
    await e.signalDeVie();
    const evts = (JSON.parse(paquets[0]!.corps) as Paquet).evenements;
    expect(evts).toEqual([
      { type: "signal_de_vie", instanceId: "inst-1", celluleId: "auto-run-1", a: expect.any(String) },
      { type: "signal_de_vie", instanceId: "inst-2", celluleId: "auto-run-1", a: expect.any(String) },
    ]);
  });

  it("[A-298] minutesGagnees = éléments × minutesGagneesParElement, en entiers", () => {
    const f = construireFin({ instanceId: "inst-1", executionId: "e", dureeMs: 10, elements: 7, minutesGagneesParElement: 3, jetons: 0, coutIaMicroCentimes: 0 });
    expect(f.minutesGagnees).toBe(21);
    for (const mauvais of [{ elements: 1.5 }, { minutesGagneesParElement: 0.5 }, { elements: -1 }, { coutIaMicroCentimes: 0.1 }, { elements: Number.MAX_SAFE_INTEGER, minutesGagneesParElement: 2 }]) {
      expect(() => construireFin({ instanceId: "inst-1", executionId: "e", dureeMs: 10, elements: 7, minutesGagneesParElement: 3, jetons: 0, coutIaMicroCentimes: 0, ...mauvais })).toThrow();
    }
  });

  it("[A-344] le tampon n'écrit que dans son dossier, un fichier par cellule", () => {
    const d = dossier();
    new TamponEvenements(d, { maxEvenements: 10 }).ajouter(debut(1));
    expect(readdirSync(d)).toEqual(["evenements.jsonl"]);
  });
});
