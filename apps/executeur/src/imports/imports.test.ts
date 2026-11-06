import { describe, expect, it } from "vitest";
import { empreinteEmail } from "@axion-auto/contrats/src/c3/evenements-crm-vers-console.ts";
import type { EntreeJournal, JournalEtapes } from "../noyau/ports.ts";
import { aiguiller, executerImport, ImportsParClient, MAX_OCTETS, type Ecrivain } from "./file-imports.ts";
import { ErreurImport, lireLignes, limiterOctets, neutraliserPourExport } from "./lecteur.ts";
import { importerParBlocs } from "./blocs.ts";
import { Dedoublonneur, normaliserEmail } from "./dedoublonner.ts";
import { classerLigne, type ListesExclusion } from "./exclusion.ts";

async function* source(morceaux: string[]): AsyncGenerator<string> { for (const m of morceaux) yield m; }
async function tout<T>(it: AsyncIterable<T>): Promise<T[]> { const r: T[] = []; for await (const x of it) r.push(x); return r; }
const csv = (n: number): string => ["email,nom", ...Array.from({ length: n }, (_, i) => `p${i}@exemple.fr,Nom ${i}`)].join("\n");

class JournalMemoire implements JournalEtapes {
  entrees: EntreeJournal[] = [];
  async inscrire(e: EntreeJournal) { this.entrees.push(e); }
  async lire(instanceId: string, executionId: string) { return this.entrees.filter((e) => e.instanceId === instanceId && e.executionId === executionId); }
}
class BaseMemoire implements Ecrivain {
  lignes: Record<string, string>[] = [];
  blocs: number[] = [];
  async existe(cle: string) { return this.lignes.some((l) => normaliserEmail(l["email"] ?? "") === cle); }
  async ecrireBloc(n: number, lignes: Record<string, string>[]) { this.blocs.push(n); this.lignes.push(...lignes); }
}
const aucune: ListesExclusion = { client: async () => false, plateforme: async () => false };
const ctx = { instanceId: "inst-1", executionId: "exec-1" };

describe("imports de fichiers par blocs", () => {
  it("[A-269] un fichier de 10 001 lignes part dans la file imports", () => {
    expect(aiguiller({ lignes: 10_001, octets: 1_000 })).toBe("imports");
    expect(aiguiller({ lignes: 10_000, octets: 1_000 })).toBe("cellule");
    expect(aiguiller({ lignes: 10, octets: 50 * 1024 * 1024 + 1 })).toBe("imports");
  });

  it("[A-270] coupure au bloc 7 : reprise au bloc 8, aucune ligne en double", async () => {
    const base = new BaseMemoire();
    const journal = new JournalMemoire();
    const ligneDe = () => lireLignes(source([csv(9_500)]));
    const dedup = () => new Dedoublonneur((c) => base.existe(c));
    let appels = 0;
    const coupe = { ...base, existe: (c: string) => base.existe(c), ecrireBloc: async (n: number, l: Record<string, string>[]) => { if (n === 8 && appels++ === 0) throw new Error("coupure"); await base.ecrireBloc(n, l); } };
    await expect(importerParBlocs({ ...ctx, lignes: ligneDe(), journal, ecrivain: coupe, dedoublonneur: dedup(), exclusions: aucune })).rejects.toThrow("coupure");
    expect(base.blocs).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const rapport = await importerParBlocs({ ...ctx, lignes: ligneDe(), journal, ecrivain: coupe, dedoublonneur: dedup(), exclusions: aucune });
    expect(base.blocs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(base.lignes).toHaveLength(9_500);
    expect(new Set(base.lignes.map((l) => l["email"])).size).toBe(9_500);
    expect(rapport.importees).toBe(2_500);
  });

  it("[A-270] un bloc écrit mais non journalisé n'est pas doublé à la reprise", async () => {
    const base = new BaseMemoire();
    await base.ecrireBloc(1, [{ email: "p0@exemple.fr" }]);
    const rapport = await importerParBlocs({ ...ctx, lignes: lireLignes(source(["email\np0@exemple.fr\np1@exemple.fr"])), journal: new JournalMemoire(), ecrivain: base, dedoublonneur: new Dedoublonneur((c) => base.existe(c)), exclusions: aucune });
    expect(base.lignes.map((l) => l["email"])).toEqual(["p0@exemple.fr", "p1@exemple.fr"]);
    expect(rapport.doublons).toBe(1);
  });

  it("[A-271] un fichier de 201 Mo est refusé avant la fin du téléversement", async () => {
    let lus = 0;
    async function* flux() { for (;;) { lus += 1; yield new Uint8Array(10 * 1024 * 1024); } }
    await expect(tout(limiterOctets(flux()))).rejects.toMatchObject({ code: "trop_gros" });
    expect(lus).toBeLessThanOrEqual(Math.ceil(MAX_OCTETS / (10 * 1024 * 1024)) + 1);
    expect(new ErreurImport("trop_gros").message).toBe("Fichier trop gros : 200 Mo au plus.");
  });

  it("[A-272] un second import du même client attend la fin du premier", () => {
    const v = new ImportsParClient();
    expect(v.demarrer("client-a", "imp-1")).toBe("demarre");
    expect(v.demarrer("client-a", "imp-2")).toBe("en_attente");
    expect(v.demarrer("client-b", "imp-3")).toBe("demarre");
    expect(v.terminer("client-a", "imp-1")).toBe("imp-2");
  });

  it("[A-273] une adresse de la liste d'exclusion n'entre pas et est comptée", async () => {
    const base = new BaseMemoire();
    const exclusions: ListesExclusion = { client: async (e) => e === empreinteEmail("stop@exemple.fr"), plateforme: async () => false };
    const rapport = await importerParBlocs({ ...ctx, lignes: lireLignes(source(["email\nstop@exemple.fr\nok@exemple.fr"])), journal: new JournalMemoire(), ecrivain: base, dedoublonneur: new Dedoublonneur((c) => base.existe(c)), exclusions });
    expect(base.lignes.map((l) => l["email"])).toEqual(["ok@exemple.fr"]);
    expect(rapport).toMatchObject({ importees: 1, exclues_client: 1 });
  });

  it("[A-273] deux lignes identiques au casse près donnent une seule ligne", async () => {
    const base = new BaseMemoire();
    const rapport = await importerParBlocs({ ...ctx, lignes: lireLignes(source(["email\nAnne@Exemple.fr\n anne@exemple.FR "])), journal: new JournalMemoire(), ecrivain: base, dedoublonneur: new Dedoublonneur((c) => base.existe(c)), exclusions: aucune });
    expect(base.lignes).toHaveLength(1);
    expect(rapport.doublons).toBe(1);
  });

  it("[C-633] une ligne présente dans la liste de la plateforme n'entre pas dans la base du client", async () => {
    const exclusions: ListesExclusion = { client: async () => false, plateforme: async (e) => e === empreinteEmail("bloque@exemple.fr") };
    expect(await classerLigne({ email: "bloque@exemple.fr" }, exclusions)).toBe("exclue_plateforme");
    const base = new BaseMemoire();
    const rapport = await importerParBlocs({ ...ctx, lignes: lireLignes(source(["email\nbloque@exemple.fr"])), journal: new JournalMemoire(), ecrivain: base, dedoublonneur: new Dedoublonneur((c) => base.existe(c)), exclusions });
    expect(base.lignes).toHaveLength(0);
    expect(rapport).toMatchObject({ importees: 0, exclues_plateforme: 1 });
  });

  it("[A-269] @isolation l'import du client A n'écrit jamais dans la base du client B", async () => {
    const bases = { a: new BaseMemoire(), b: new BaseMemoire() };
    const demandes: string[] = [];
    const ports = {
      verrou: new ImportsParClient(),
      journal: new JournalMemoire(),
      ecrivainPour: (t: string) => { demandes.push(t); return t === "client-a" ? bases.a : bases.b; },
      dedoublonneurPour: (t: string) => new Dedoublonneur((c) => (t === "client-a" ? bases.a : bases.b).existe(c)),
      exclusions: aucune,
    };
    const r = await executerImport({ tenantId: "client-a", importId: "imp-1", ...ctx, lignes: lireLignes(source([csv(3)])) }, ports);
    expect(r.statut).toBe("termine");
    expect(demandes).toEqual(["client-a"]);
    expect(bases.a.lignes).toHaveLength(3);
    expect(bases.b.lignes).toHaveLength(0);
  });

  it("[A-273] une formule de tableur reste du texte à l'import et est neutralisée à l'export", async () => {
    const [l] = await tout(lireLignes(source(['email,nom\na@exemple.fr,"=1+1"'])));
    expect(l?.["nom"]).toBe("=1+1");
    for (const v of ["=1+1", "+2", "@x", "-3"]) expect(neutraliserPourExport(v)).toBe(`'${v}`);
    expect(neutraliserPourExport("Marceau")).toBe("Marceau");
  });
});
