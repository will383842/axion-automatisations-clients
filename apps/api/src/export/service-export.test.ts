import { describe, expect, it } from "vitest";
import { GelPourLitige } from "../gel/garde.js";
import { DUREE_LIEN_EXPORT, creerServiceExport, dateExpiration, type EntreeRegistre, type PortsService } from "./exporter.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const D1 = "33333333-3333-4333-8333-333333333333";
const D2 = "44444444-4444-4444-8444-444444444444";
const T0 = new Date("2026-11-02T10:00:00Z");

type Etape = "intention" | "objet" | "marquer" | "confirmation";
function monde(o: { retraitActif?: boolean; gel?: string[]; gelDansTransaction?: string[]; echec?: Etape; maintenant?: Date; entrees?: EntreeRegistre[] } = {}) {
  const entrees: EntreeRegistre[] = o.entrees ?? [{ tenantId: A, demande: D1, cle: `exports/${D1}.zip`, expireLe: dateExpiration(T0), retire: false }];
  const liens: { tenantId: string; cle: string; secondes: number }[] = [];
  const retires: string[] = [];
  const jobs: { id: string; donnees: unknown }[] = [];
  const traces: Record<string, unknown>[] = [];
  const ordre: string[] = [];
  const casse = (e: Etape) => { if (o.echec === e) throw new Error(`panne_${e}`); };
  const p: PortsService = {
    registre: {
      async trouver(t, d) { return entrees.find((e) => e.tenantId === t && !e.retire && (d === undefined || e.demande === d)); },
      async expires(m) { return entrees.filter((e) => !e.retire && e.expireLe.getTime() <= m.getTime()); },
      async marquerRetire(t, d) { casse("marquer"); ordre.push("marque"); const e = entrees.find((x) => x.tenantId === t && x.demande === d); if (e) e.retire = true; },
    },
    file: { async ajouter(id, donnees) { jobs.push({ id, donnees }); } },
    async lien(tenantId, cle, secondes) { liens.push({ tenantId, cle, secondes }); return `https://stockage.test/${cle}?sig=x`; },
    async retirerObjet(t, cle) { casse("objet"); ordre.push("objet"); retires.push(`${t}:${cle}`); },
    // Le verrou par client : le gel est relu DANS cette transaction (un gel posé entre la liste des échus et la suppression est vu ici).
    async sousVerrou(_t, f) { return f({ gelActif: async (t: string) => (o.gel ?? []).includes(t) || (o.gelDansTransaction ?? []).includes(t) }); },
    retraitActif: o.retraitActif ?? false,
    async tracer(e) {
      if (e["type"] === "export_retrait_intention") casse("intention");
      if (e["type"] === "export_retire") casse("confirmation");
      ordre.push(String(e["type"]));
      traces.push(e);
    },
    maintenant: () => o.maintenant ?? T0,
    nouvelleDemande: () => D2,
  };
  return { s: creerServiceExport(p), liens, retires, jobs, traces, entrees, ordre };
}

describe("service d'export : demande, lien signé, retrait", () => {
  it("[B-371] l'export est demandable à tout moment par le client", async () => {
    const m = monde();
    const r = await m.s.demander({ tenantId: A, acteur: "client" });
    expect(r.demande).toBe(D2);
    expect(m.jobs).toEqual([{ id: `export:${A}:${D2}`, donnees: { tenantId: A, demande: D2, acteur: "client" } }]);
    // une seconde demande, tout de suite après, est acceptée aussi
    await expect(m.s.demander({ tenantId: A, acteur: "client" })).resolves.toBeDefined();
    expect(m.traces.some((t) => t["type"] === "export_demande" && t["tenantId"] === A)).toBe(true);
  });

  it("[A-252] l'export reste disponible 30 jours ; le lien signé dure 15 minutes au plus", async () => {
    const m = monde({ maintenant: new Date(T0.getTime() + 29 * 86_400_000) });
    const r = await m.s.lien({ tenantId: A, acteur: "client" });
    expect(r.lien).toContain("exports/");
    expect(DUREE_LIEN_EXPORT).toBeLessThanOrEqual(900);
    expect(m.liens).toEqual([{ tenantId: A, cle: `exports/${D1}.zip`, secondes: DUREE_LIEN_EXPORT }]);
    expect(r.lienExpireLe.getTime() - (T0.getTime() + 29 * 86_400_000)).toBe(DUREE_LIEN_EXPORT * 1000);
    expect(m.traces.some((t) => t["type"] === "export_telecharge")).toBe(true);
    // au-delà de 30 jours : plus de lien
    const tard = monde({ maintenant: new Date(T0.getTime() + 31 * 86_400_000) });
    await expect(tard.s.lien({ tenantId: A, acteur: "client" })).rejects.toThrow("export_expire");
    expect(tard.liens).toEqual([]);
  });

  it("[C-536] le lien d'un export demandé avec le tenant de A ne sert jamais un export de B", async () => {
    const m = monde({ entrees: [{ tenantId: B, demande: D1, cle: `exports/${D1}.zip`, expireLe: dateExpiration(T0), retire: false }] });
    await expect(m.s.lien({ tenantId: A, demande: D1, acteur: "client" })).rejects.toThrow("introuvable");
    expect(m.liens).toEqual([]);
  });

  it("[A-252] retrait à 30 jours : interrupteur fermé, rien n'est retiré", async () => {
    const m = monde({ retraitActif: false, maintenant: new Date(T0.getTime() + 31 * 86_400_000) });
    expect(await m.s.retirerExpires()).toEqual({ retires: 0, suspendus: 0, ferme: true });
    expect(m.retires).toEqual([]);
    expect(m.entrees[0]?.retire).toBe(false);
  });

  it("[A-252] retrait à 30 jours : interrupteur ouvert, seule la copie d'export échue est retirée", async () => {
    const recent = { tenantId: B, demande: D2, cle: `exports/${D2}.zip`, expireLe: dateExpiration(new Date(T0.getTime() + 20 * 86_400_000)), retire: false };
    const ancien = { tenantId: A, demande: D1, cle: `exports/${D1}.zip`, expireLe: dateExpiration(T0), retire: false };
    const m = monde({ retraitActif: true, maintenant: new Date(T0.getTime() + 31 * 86_400_000), entrees: [ancien, recent] });
    expect(await m.s.retirerExpires()).toEqual({ retires: 1, suspendus: 0, ferme: false });
    expect(m.retires).toEqual([`${A}:exports/${D1}.zip`]);
    expect(ancien.retire).toBe(true);
    expect(recent.retire).toBe(false);
  });

  it("[C-609] un gel pour litige suspend le retrait de l'export, qui reprend après la levée", async () => {
    const gel = [A];
    const m = monde({ retraitActif: true, gel, maintenant: new Date(T0.getTime() + 31 * 86_400_000) });
    expect(await m.s.retirerExpires()).toEqual({ retires: 0, suspendus: 1, ferme: false });
    expect(m.retires).toEqual([]);
    gel.length = 0;
    expect(await m.s.retirerExpires()).toEqual({ retires: 1, suspendus: 0, ferme: false });
    expect(GelPourLitige).toBeDefined();
  });

  it("[C-536] la demande de l'équipe exige une fin de contrat ou une demande écrite du client, tracée", async () => {
    const m = monde();
    await expect(m.s.demanderParEquipe({ tenantId: A, acteur: "equipe:u1", motif: "curiosite" as never })).rejects.toThrow("motif_invalide");
    expect(m.jobs).toEqual([]);
    await m.s.demanderParEquipe({ tenantId: A, acteur: "equipe:u1", motif: "fin_de_contrat" });
    expect(m.jobs).toHaveLength(1);
    expect(m.traces.find((t) => t["type"] === "export_demande")).toMatchObject({ acteur: "equipe:u1", motif: "fin_de_contrat" });
  });

  describe("retrait : garde de clé, intention avant suppression, gel relu sous verrou", () => {
    const apres = new Date(T0.getTime() + 31 * 86_400_000);
    const echu = (cle: string): EntreeRegistre => ({ tenantId: A, demande: D1, cle, expireLe: dateExpiration(T0), retire: false });

    it("[A-252] retrait : une clé du registre qui n'est pas exports/<demande>.zip est refusée sans suppression", async () => {
      for (const cle of ["cli-x/fichiers/contrat.pdf", `exports/${D2}.zip`, `exports/${D1}.zip/../autre`, "exports/"]) {
        const m = monde({ retraitActif: true, maintenant: apres, entrees: [echu(cle)] });
        expect(await m.s.retirerExpires()).toEqual({ retires: 0, suspendus: 0, ferme: false });
        expect(m.retires).toEqual([]);
        expect(m.entrees[0]?.retire).toBe(false);
        expect(m.traces.find((t) => t["type"] === "export_retrait_refuse")).toMatchObject({ tenantId: A, demande: D1, motif: "cle_inattendue" });
      }
    });

    it("[A-252] retrait : l'intention est tracée avant la suppression, la confirmation après", async () => {
      const m = monde({ retraitActif: true, maintenant: apres });
      await m.s.retirerExpires();
      expect(m.ordre).toEqual(["export_retrait_intention", "objet", "marque", "export_retire"]);
    });

    it("[A-252] retrait : si l'intention ne s'écrit pas, rien n'est supprimé", async () => {
      const m = monde({ retraitActif: true, maintenant: apres, echec: "intention" });
      await expect(m.s.retirerExpires()).rejects.toThrow("panne_intention");
      expect(m.retires).toEqual([]);
      expect(m.entrees[0]?.retire).toBe(false);
    });

    it("[A-252] retrait : si la suppression échoue, l'intention reste tracée et rien n'est confirmé", async () => {
      const m = monde({ retraitActif: true, maintenant: apres, echec: "objet" });
      await expect(m.s.retirerExpires()).rejects.toThrow("panne_objet");
      expect(m.traces.map((t) => t["type"])).toEqual(["export_retrait_intention"]);
      expect(m.entrees[0]?.retire).toBe(false);
    });

    it("[A-252] retrait : si le registre ne se marque pas, l'intention reste tracée et la reprise retire de nouveau", async () => {
      const m = monde({ retraitActif: true, maintenant: apres, echec: "marquer" });
      await expect(m.s.retirerExpires()).rejects.toThrow("panne_marquer");
      expect(m.retires).toHaveLength(1);
      expect(m.traces.map((t) => t["type"])).toEqual(["export_retrait_intention"]);
      expect(m.entrees[0]?.retire).toBe(false);
    });

    it("[A-252] retrait : si la confirmation ne s'écrit pas, l'intention reste au journal", async () => {
      const m = monde({ retraitActif: true, maintenant: apres, echec: "confirmation" });
      await expect(m.s.retirerExpires()).rejects.toThrow("panne_confirmation");
      expect(m.traces.map((t) => t["type"])).toEqual(["export_retrait_intention"]);
    });

    it("[C-609] un gel posé entre la liste des échus et la suppression est vu dans la transaction : rien n'est supprimé", async () => {
      const m = monde({ retraitActif: true, maintenant: apres, gelDansTransaction: [A] });
      expect(await m.s.retirerExpires()).toEqual({ retires: 0, suspendus: 1, ferme: false });
      expect(m.retires).toEqual([]);
      expect(m.entrees[0]?.retire).toBe(false);
      expect(m.traces.map((t) => t["type"])).toEqual(["export_retrait_suspendu"]);
    });
  });
});
