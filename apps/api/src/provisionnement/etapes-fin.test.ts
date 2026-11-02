import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contexteBase } from "./etapes-base.js";
import { assemblerEtapes, etapesFin, type ConnexionApp, type PortsFin } from "./etapes-fin.js";
import { creerMachine, type LigneBase, type Registre } from "./machine.js";

const T = randomUUID();
const ligne: LigneBase = { etat: "en_creation", etape: 7, grappe: "donnees-1", nomBase: "cli_x" };
function monter(options: { pannes?: Partial<Record<"ecrire" | "relire" | "objet" | "retrait", boolean>> } = {}) {
  const journal: string[] = [];
  const base = new Map<string, string>();
  const objets = new Map<string, Uint8Array>();
  let ouverts = 0;
  const pannes = options.pannes ?? {};
  const ports: PortsFin = {
    connexionApp: async (nomBase) => {
      ouverts++;
      journal.push(`connexion:${nomBase}`);
      return {
        requete: (async (texte: string, valeurs?: unknown[]) => {
          journal.push(texte.split(" ").slice(0, 2).join(" "));
          if (/^INSERT INTO commun.etablissements/.test(texte)) return [{ id: "e1" }];
          if (/^INSERT/.test(texte)) { if (pannes.ecrire) throw new Error("refus"); base.set("p", String((valeurs ?? [])[2])); return []; }
          if (/^SELECT/.test(texte)) return pannes.relire ? [] : [{ courriel_chiffre: Buffer.from(base.get("p") ?? "") }];
          return [];
        }) as unknown as ConnexionApp["requete"],
        fermer: async () => { ouverts--; journal.push("fermer"); },
      };
    },
    colonnes: {
      chiffrerChamp: async (_t, valeur) => Buffer.from(`chiffre:${valeur}`),
      dechiffrerChamp: async (_t, octets) => Buffer.from(octets).toString().replace("chiffre:", ""),
    },
    objets: {
      deposer: async (_t, cle, o) => { if (pannes.objet) throw new Error("refus"); objets.set(cle, o); },
      lire: async (_t, cle) => objets.get(cle),
      retirer: async (_t, cle) => { if (pannes.retrait) throw new Error("refus"); objets.delete(cle); },
    },
    versionStructure: async () => 1,
    registre: { activer: async (t, v) => { journal.push(`active:${t}:${v}`); }, estActive: async () => journal.some((j) => j.startsWith("active:")) },
    trace: { tracer: async (e) => { journal.push(`trace:${e.action}:${e.tenantId}`); } },
  };
  const etapes = etapesFin(ports);
  return { ports, etapes, journal, base, objets, ouverts: () => ouverts, etape: (n: number) => etapes.find((e) => e.numero === n)!, ctx: () => contexteBase(T, ligne) };
}

describe("étape 8 : fumée", () => {
  it("[A-221] la fumée écrit, relit, dépose, relit, retire, et ne laisse rien", async () => {
    const m = monter();
    await m.etape(8).faire(m.ctx());
    expect(m.journal).toContain(`connexion:${contexteBase(T, ligne).nomBase}`);
    expect(m.journal).toContain("ROLLBACK");
    expect(m.journal.at(-1)).toBe("fermer");
    expect(m.objets.size).toBe(0);
    expect(m.ouverts()).toBe(0);
  });
  it("[A-221] la transaction est annulée et la connexion fermée même si l'écriture échoue", async () => {
    const m = monter({ pannes: { ecrire: true } });
    await expect(m.etape(8).faire(m.ctx())).rejects.toMatchObject({ code: "fumee_echouee" });
    expect(m.journal).toContain("ROLLBACK");
    expect(m.ouverts()).toBe(0);
  });
  it("[A-221] la relecture vide, le dépôt refusé ou l'objet non retiré mettent l'étape en échec", async () => {
    for (const panne of ["relire", "objet", "retrait"] as const) {
      const m = monter({ pannes: { [panne]: true } });
      await expect(m.etape(8).faire(m.ctx()), panne).rejects.toMatchObject({ code: "fumee_echouee" });
      expect(m.ouverts()).toBe(0);
    }
  });
  it("[A-221] la fumée n'est jamais « déjà faite » : elle se rejoue à chaque passage", async () => {
    expect(await monter().etape(8).dejaFait(monter().ctx())).toBe(false);
  });
});

describe("étape 9 : inscription", () => {
  it("[A-222] la base passe active avec sa version de structure et la création est tracée", async () => {
    const m = monter();
    await m.etape(9).faire(m.ctx());
    expect(m.journal).toEqual([`trace:base_client_creee:${T}`, `active:${T}:1`]);
  });
  it("[A-222] une base déjà active n'est ni réinscrite ni retracée", async () => {
    const m = monter();
    await m.etape(9).faire(m.ctx());
    expect(await m.etape(9).dejaFait(m.ctx())).toBe(true);
  });
  it("[A-222] une version de structure illisible empêche l'inscription", async () => {
    const m = monter();
    m.ports.versionStructure = async () => 0;
    await expect(m.etape(9).faire(m.ctx())).rejects.toMatchObject({ code: "version_illisible" });
    expect(m.journal).toEqual([]);
  });
});

describe("assemblage des neuf étapes", () => {
  it("[A-213] les étapes sont rendues dans l'ordre 1 à 9, sans trou ni doublon", () => {
    const nums = (n: number[]) => n.map((numero) => ({ numero, nom: `e${numero}`, faire: async () => undefined, dejaFait: async () => false }));
    expect(assemblerEtapes(nums([7, 1, 3, 2]), nums([5, 4, 6]), nums([9, 8])).map((e) => e.numero)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(() => assemblerEtapes(nums([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
    expect(() => assemblerEtapes(nums([1, 2, 3, 4, 5, 6, 7, 8, 9, 9]))).toThrow();
  });
  it("[A-222] une étape qui échoue avant la fin : la base n'est jamais marquée active (état sauté)", async () => {
    const m = monter({ pannes: { objet: true } });
    const avant = ["1", "2", "3", "4", "5", "6", "7"].map((n) => ({ numero: Number(n), nom: `e${n}`, faire: async () => undefined, dejaFait: async () => true }));
    const etapes = assemblerEtapes(avant, m.etapes);
    const alertes: string[] = [];
    const registre: Registre = { lire: async () => ligne, enregistrerEtape: async () => undefined, noterErreur: async () => undefined };
    const machine = creerMachine({ etapes, registre, alertes: { envoyer: async (a) => { alertes.push(a.code); } }, contexte: (t, l) => contexteBase(t, l) });
    await expect(machine.executer(T)).rejects.toMatchObject({ code: "fumee_echouee" });
    expect(m.journal.some((j) => j.startsWith("active:"))).toBe(false);
    expect(alertes).toEqual(["fumee_echouee"]);
  });
});
