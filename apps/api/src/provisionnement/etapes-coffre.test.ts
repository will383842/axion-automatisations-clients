import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contexteBase } from "./etapes-base.js";
import { etapesCoffre, type PortsCoffreClient } from "./etapes-coffre.js";
import type { LigneBase } from "./machine.js";

const A = randomUUID();
const B = randomUUID();
function monter(options: { quota?: Map<string, number> } = {}) {
  const cles = new Set<string>();
  const compartiments = new Map<string, string>();
  const quotas = options.quota ?? new Map<string, number>();
  const appels: string[] = [];
  const ports: PortsCoffreClient = {
    cle: { existe: async (nom) => cles.has(nom), creer: async (nom) => { appels.push(`cle:${nom}`); cles.add(nom); } },
    compartiment: {
      identifiants: async (t) => (compartiments.has(t) ? { compartiment: compartiments.get(t)! } : undefined),
      creer: async (t) => { appels.push(`compartiment:${t}`); compartiments.set(t, `cli-${t}`); },
      quota: async (t) => quotas.get(t),
      poserQuota: async (t, n) => { appels.push(`quota:${t}:${n}`); quotas.set(t, n); },
    },
    quotaFichiers: async () => 5000,
  };
  const ligne: LigneBase = { etat: "en_creation", etape: 3, grappe: "donnees-1", nomBase: "cli_x" };
  const etapes = etapesCoffre(ports);
  return { ports, etapes, cles, compartiments, quotas, appels, etape: (n: number) => etapes.find((e) => e.numero === n)!, ctx: (t: string) => contexteBase(t, ligne) };
}

describe("étape 4 : clé du client", () => {
  it("[A-217] la clé du client et sa clé de recherche sont créées, dejaFait vaut les deux", async () => {
    const m = monter();
    const c = m.ctx(A);
    expect(await m.etape(4).dejaFait(c)).toBe(false);
    await m.etape(4).faire(c);
    expect([...m.cles].sort()).toEqual([`cli-${A}`, `cli-${A}-recherche`]);
    expect(await m.etape(4).dejaFait(c)).toBe(true);
  });
  it("[A-217] une seule des deux clés présente : l'étape n'est pas faite et ne crée que l'absente", async () => {
    const m = monter();
    m.cles.add(`cli-${A}`);
    const c = m.ctx(A);
    expect(await m.etape(4).dejaFait(c)).toBe(false);
    await m.etape(4).faire(c);
    expect(m.appels).toEqual([`cle:cli-${A}-recherche`]);
  });
  it("[A-167] chaque base client a sa propre clé de chiffrement : la création de A ne touche jamais celle de B", async () => {
    const m = monter();
    await m.etape(4).faire(m.ctx(A));
    expect(await m.etape(4).dejaFait(m.ctx(B))).toBe(false);
    await m.etape(4).faire(m.ctx(B));
    expect(m.appels.filter((a) => a.includes(B)).length).toBe(2);
    expect(m.appels.filter((a) => a.includes(A)).length).toBe(2);
  });
  it("[A-217] un échec du coffre donne un code, sans reprendre le texte de l'erreur", async () => {
    const m = monter();
    m.ports.cle.creer = async () => { throw new Error("valeur-sensible-essai refusée"); };
    const e = await m.etape(4).faire(m.ctx(A)).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "cle_client_echouee" });
    expect(String((e as Error).message)).not.toContain("sensible");
  });
});

describe("étape 5 : compartiment du client", () => {
  it("[A-218] le compartiment cli-<id> est créé avec le quota du palier", async () => {
    const m = monter();
    const c = m.ctx(A);
    expect(await m.etape(5).dejaFait(c)).toBe(false);
    await m.etape(5).faire(c);
    expect(m.appels).toEqual([`compartiment:${A}`, `quota:${A}:5000`]);
    expect(await m.etape(5).dejaFait(c)).toBe(true);
  });
  it("[A-218] rejeu : un compartiment présent n'est pas recréé, seul le quota manquant est posé", async () => {
    const m = monter();
    m.compartiments.set(A, `cli-${A}`);
    await m.etape(5).faire(m.ctx(A));
    expect(m.appels).toEqual([`quota:${A}:5000`]);
  });
  it("[A-201] @isolation des identifiants rangés pour le compartiment d'un autre client ne comptent jamais pour fait", async () => {
    const m = monter();
    m.compartiments.set(A, `cli-${B}`);
    await expect(m.etape(5).dejaFait(m.ctx(A))).rejects.toMatchObject({ code: "identifiants_etrangers" });
  });
  it("[A-218] un quota illisible ou nul arrête l'étape, sans valeur de repli", async () => {
    const m = monter();
    m.ports.quotaFichiers = async () => 0;
    await expect(m.etape(5).faire(m.ctx(A))).rejects.toMatchObject({ code: "quota_invalide" });
    expect(m.appels).toEqual([]);
  });
});
