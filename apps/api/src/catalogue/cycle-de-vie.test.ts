import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErreurApi } from "../plugins/erreurs.js";
import { construireServeur } from "../serveur.js";
import { peutContinuerExecution, passagePermis, versionDeployable, versionVendable, etapesRequises, type Statut } from "./cycle-de-vie.js";
import { lireDemandePassage, lireDemandePreuve } from "./procedure.js";
import { creerCycle, type DepotCycle, type Tx } from "./preuves.js";

// Machine d'états côté serveur (T4-27b) essayée sur un dépôt en mémoire qui reproduit les règles du dépôt SQL : horloge du SERVEUR seule,
// preuves comptées pour une empreinte et jusqu'à l'heure du passage, version verrouillée pendant la transaction. Données inventées.
const JOUR = 86_400_000;
const H = (s: string) => createHash("sha256").update(s).digest("hex");
interface V { id: string; statut: Statut; empreinte: string; automatisationId: string; module: string; semver: string; schemaVide: boolean; modeles: string[] | null }
interface Pa { versionId: string; depart: Statut; arrivee: Statut; empreinte: string; fin: string | null; remplacante: string | null; prevenance: string | null; auteur: string; le: number }
interface Pr { versionId: string; etape: number; empreinte: string; reference: string | null; mesure: number | null; contenu: Record<string, unknown>; auteur: string; le: number }

function monde(o: { etape6?: boolean; definitives?: number; echecEtape10?: boolean } = {}) {
  const horloge = { t: Date.UTC(2026, 10, 10, 8) };
  const versions = new Map<string, V>();
  const passages: Pa[] = [];
  const preuves: Pr[] = [];
  const appelsModeles: string[][] = [];
  const erreurs = { definitives: o.definitives ?? 0, appels: [] as { id: string; depuis: Date }[], async compterDefinitives(id: string, depuis: Date) { this.appels.push({ id, depuis }); return this.definitives; } };
  const journal: { action: string; parQui: string }[] = [];
  const depot: DepotCycle = {
    async transaction(acteur, fn) {
      const copie = { v: structuredClone([...versions]), pa: structuredClone(passages), pr: structuredClone(preuves) };
      const tx: Tx = {
        async verrouiller(id) {
          const v = versions.get(id);
          return v ? { id, statut: v.statut, empreinte: v.empreinte, automatisationId: v.automatisationId, module: v.module, semver: v.semver, schemaConfigurationVide: v.schemaVide } : undefined;
        },
        async etapesProuvees(id, empreinte, borne) {
          const limite = borne === null ? horloge.t : Math.max(-Infinity, ...passages.filter((p) => p.versionId === id && p.arrivee === borne && p.empreinte === empreinte).map((p) => p.le));
          return [...new Set(preuves.filter((p) => p.versionId === id && p.empreinte === empreinte && p.le <= limite).map((p) => p.etape))];
        },
        async delaiPilote(id, empreinte) {
          const l = passages.filter((p) => p.versionId === id && p.empreinte === empreinte && p.depart === "recette" && p.arrivee === "pilote").sort((a, b) => b.le - a.le)[0];
          if (!l || passages.some((p) => p.versionId === id && p.arrivee === "brouillon" && p.le > l.le)) return undefined;
          return { debut: new Date(l.le), ecoule: horloge.t >= l.le + 7 * JOUR };
        },
        async remplacante(id) {
          const v = versions.get(id);
          return v ? { statut: v.statut, automatisationId: v.automatisationId } : undefined;
        },
        async dateServeur() { return new Date(horloge.t).toISOString().slice(0, 10); },
        async ranger(p) {
          if (p.etape === 10 && o.echecEtape10) throw new Error("panne simulée");
          if (preuves.some((x) => x.versionId === p.versionId && x.etape === p.etape && x.empreinte === p.empreinte)) return false;
          preuves.push({ versionId: p.versionId, etape: p.etape, empreinte: p.empreinte, reference: p.reference, mesure: p.mesureMs, contenu: p.contenu, auteur: acteur, le: horloge.t });
          return true;
        },
        async ecrireModelesTestes(id, modeles) { appelsModeles.push(modeles); (versions.get(id) as V).modeles = modeles; },
        async ecrirePassage(p) { passages.push({ versionId: p.versionId, depart: p.depart, arrivee: p.arrivee, empreinte: p.empreinte, fin: p.finAnnonceeLe, remplacante: p.remplacanteId, prevenance: p.prevenanceLe, auteur: acteur, le: horloge.t }); },
        async changerStatut(id, arrivee) { (versions.get(id) as V).statut = arrivee; },
      };
      try {
        return await fn(tx);
      } catch (e) {
        versions.clear();
        for (const [k, v] of copie.v) versions.set(k, v);
        passages.splice(0, passages.length, ...copie.pa);
        preuves.splice(0, preuves.length, ...copie.pr);
        throw e;
      }
    },
  };
  const cycle = creerCycle({ depot, erreursPilote: erreurs, journal: { async ecrire(e) { journal.push({ action: e.action, parQui: e.parQui }); } }, interrupteurs: { etape6Exigee: o.etape6 ?? false } });
  const ajouter = (statut: Statut = "brouillon", extra: Partial<V> = {}) => {
    const id = randomUUID();
    versions.set(id, { id, statut, empreinte: H(id), automatisationId: "auto-1", module: "module-essai", semver: "1.0.0", schemaVide: false, modeles: null, ...extra });
    return id;
  };
  const empreinte = (id: string) => (versions.get(id) as V).empreinte;
  const prouver = (id: string, etapes: number[], avec: { empreinte?: string; le?: number } = {}) => {
    for (const etape of etapes) preuves.push({ versionId: id, etape, empreinte: avec.empreinte ?? empreinte(id), reference: `ref-${etape}`, mesure: etape === 7 ? 900 : null, contenu: {}, auteur: "equipe-essai", le: avec.le ?? horloge.t });
  };
  const demande = (id: string, depart: Statut, vers: Statut, extra: Record<string, unknown> = {}) => lireDemandePassage({ depart, vers, empreinte_sha256: empreinte(id), ...extra });
  const passer = (id: string, depart: Statut, vers: Statut, extra: Record<string, unknown> = {}) => cycle.passer(id, demande(id, depart, vers, extra), "equipe-essai");
  const avancer = (jours: number) => { horloge.t += jours * JOUR; };
  const forger = (id: string, depart: Statut, arrivee: Statut, le = horloge.t) => passages.push({ versionId: id, depart, arrivee, empreinte: empreinte(id), fin: null, remplacante: null, prevenance: null, auteur: "insider-essai", le });
  // Chaîne complète par la machine : brouillon → recette → pilote, avec toutes les preuves.
  const jusquAuPilote = async (id: string) => {
    prouver(id, [1, 2, 3, 5, 8]);
    await passer(id, "brouillon", "recette");
    prouver(id, o.etape6 ? [4, 6, 7] : [4, 7]);
    await passer(id, "recette", "pilote");
  };
  return { horloge, versions, passages, preuves, appelsModeles, erreurs, journal, depot, cycle, ajouter, empreinte, prouver, demande, passer, avancer, forger, jusquAuPilote };
}
const message = async (p: Promise<unknown>) => {
  try {
    await p;
    return "";
  } catch (e) {
    if (!(e instanceof ErreurApi)) throw e;
    return e.message;
  }
};
afterEach(() => vi.useRealTimers());

describe("cycle de vie : prédicats purs", () => {
  it("[A-031] déployer une version en recette chez un client : refusé", () => {
    expect(versionDeployable("recette", false)).toBe(false);
    expect(versionDeployable("brouillon", false)).toBe(false);
    expect(versionDeployable("brouillon", true)).toBe(false);
    expect(versionDeployable("recette", true)).toBe(false);
    expect(versionDeployable("pilote", false)).toBe(false);
    expect(versionDeployable("pilote", true)).toBe(true);
  });

  it("[B-460] seule une version publiee est vendable et déployable", () => {
    for (const s of ["brouillon", "recette", "pilote", "depreciee", "retiree"] as Statut[]) expect(versionVendable(s)).toBe(false);
    expect(versionVendable("publiee")).toBe(true);
    expect(versionDeployable("publiee", false)).toBe(true);
    for (const s of ["depreciee", "retiree"] as Statut[]) expect(versionDeployable(s, false)).toBe(false);
  });

  it("[A-307] retrait : l'instance pas encore migrée continue jusqu'à sa migration", () => {
    expect(peutContinuerExecution("retiree", false)).toBe(true);
    expect(peutContinuerExecution("retiree", true)).toBe(false);
    expect(peutContinuerExecution("depreciee", false)).toBe(true);
    expect(peutContinuerExecution("publiee", false)).toBe(true);
    expect(peutContinuerExecution("recette", false)).toBe(false);
  });

  it("[A-305] seuls les six passages du graphe sont permis", () => {
    const permis = [["brouillon", "recette"], ["recette", "brouillon"], ["recette", "pilote"], ["pilote", "publiee"], ["publiee", "depreciee"], ["depreciee", "retiree"]];
    const tous: Statut[] = ["brouillon", "recette", "pilote", "publiee", "depreciee", "retiree"];
    for (const d of tous) for (const a of tous) expect(passagePermis(d, a)).toBe(permis.some(([x, y]) => x === d && y === a));
  });

  it("[C-246] l'étape 6 n'est exigée que si l'interrupteur procedure.etape6Exigee est ouvert (fermé par défaut)", () => {
    expect(etapesRequises("pilote", { etape6Exigee: false })).toEqual([4, 7]);
    expect(etapesRequises("pilote", { etape6Exigee: true })).toEqual([4, 6, 7]);
    expect(etapesRequises("recette", { etape6Exigee: true })).toEqual([1, 2, 3, 5, 8]);
    expect(etapesRequises("publiee", { etape6Exigee: true })).toEqual([]);
  });
});

describe("cycle de vie : passages côté serveur", () => {
  it("[A-305] brouillon → publiee directement est refusé", async () => {
    const m = monde();
    const id = m.ajouter();
    m.prouver(id, [1, 2, 3, 4, 5, 7, 8]);
    expect(await message(m.passer(id, "brouillon", "publiee", { signature_production: "signature-prod-essai" }))).toContain("Passage non permis");
    expect(await message(m.passer(id, "brouillon", "pilote"))).toContain("Passage non permis");
    expect((m.versions.get(id) as V).statut).toBe("brouillon");
    expect(m.passages).toHaveLength(0);
  });

  it("[C-240] passage en recette sans les étapes 1, 2, 3, 5 et 8 : refusé avec la liste des étapes manquantes", async () => {
    const m = monde();
    const id = m.ajouter();
    expect(await message(m.passer(id, "brouillon", "recette"))).toContain("Étapes manquantes : 1, 2, 3, 5, 8");
    m.prouver(id, [1, 2]);
    expect(await message(m.passer(id, "brouillon", "recette"))).toContain("Étapes manquantes : 3, 5, 8");
    m.prouver(id, [3, 5, 8]);
    await m.passer(id, "brouillon", "recette");
    expect((m.versions.get(id) as V).statut).toBe("recette");
    expect(m.passages).toHaveLength(1);
    expect(m.passages[0]).toMatchObject({ depart: "brouillon", arrivee: "recette", auteur: "equipe-essai" });
  });

  it("[C-248] passage en recette sans signature de recette : refusé", async () => {
    const m = monde();
    const id = m.ajouter();
    m.prouver(id, [1, 2, 3, 5]);
    expect(await message(m.passer(id, "brouillon", "recette"))).toContain("Étapes manquantes : 8");
  });

  it("[C-240] une version sans schéma de réglages n'a pas la preuve de l'étape 3, même rangée", async () => {
    const m = monde();
    const id = m.ajouter("brouillon", { schemaVide: true });
    m.prouver(id, [1, 2, 3, 5, 8]);
    expect(await message(m.passer(id, "brouillon", "recette"))).toContain("Étapes manquantes : 3");
  });

  it("[C-240] passage en pilote sans rapport du harnais : refusé avec l'étape manquante", async () => {
    const m = monde();
    const id = m.ajouter();
    m.prouver(id, [1, 2, 3, 5, 8]);
    await m.passer(id, "brouillon", "recette");
    m.prouver(id, [7]);
    expect(await message(m.passer(id, "recette", "pilote"))).toContain("Étapes manquantes : 4");
    expect((m.versions.get(id) as V).statut).toBe("recette");
    m.prouver(id, [4]);
    await m.passer(id, "recette", "pilote");
    expect((m.versions.get(id) as V).statut).toBe("pilote");
  });

  it("[C-246] l'interrupteur fermé n'exige pas l'étape 6 ; ouvert, il l'exige avant le pilote", async () => {
    for (const ouvert of [false, true]) {
      const m = monde({ etape6: ouvert });
      const id = m.ajouter();
      m.prouver(id, [1, 2, 3, 5, 8]);
      await m.passer(id, "brouillon", "recette");
      m.prouver(id, [4, 7]);
      expect(await message(m.passer(id, "recette", "pilote"))).toEqual(ouvert ? expect.stringContaining("Étapes manquantes : 6") : "");
    }
  });

  it("[C-240] une preuve rangée pour une autre empreinte ne compte pas (artefact changé pendant la recette)", async () => {
    const m = monde();
    const id = m.ajouter();
    m.prouver(id, [1, 2, 3, 5, 8], { empreinte: H("ancien-artefact") });
    expect(await message(m.passer(id, "brouillon", "recette"))).toContain("Étapes manquantes : 1, 2, 3, 5, 8");
    m.prouver(id, [1, 2, 3, 5, 8]);
    await m.passer(id, "brouillon", "recette");
    m.prouver(id, [4, 7]);
    (m.versions.get(id) as V).empreinte = H("artefact-remplace");
    expect(await message(m.cycle.passer(id, lireDemandePassage({ depart: "recette", vers: "pilote", empreinte_sha256: H("artefact-remplace") }), "equipe-essai"))).toContain("Étapes manquantes : 1, 2, 3, 4, 5, 7, 8");
  });

  it("[C-240] une preuve rangée après le passage qu'elle devait permettre ne compte pas", async () => {
    const m = monde();
    const id = m.ajouter();
    // Entrée en recette sans preuve (hors route), puis preuves rangées plus tard : elles ne régularisent rien.
    m.forger(id, "brouillon", "recette");
    (m.versions.get(id) as V).statut = "recette";
    m.avancer(1);
    m.prouver(id, [1, 2, 3, 4, 5, 7, 8]);
    expect(await message(m.passer(id, "recette", "pilote"))).toContain("Étapes manquantes : 1, 2, 3, 5, 8");
    // Pilote atteint sans les étapes 4 et 7, preuves rangées ensuite : la publication reste refusée.
    const autre = m.ajouter();
    m.prouver(autre, [1, 2, 3, 5, 8]);
    m.forger(autre, "brouillon", "recette");
    m.forger(autre, "recette", "pilote");
    (m.versions.get(autre) as V).statut = "pilote";
    m.avancer(8);
    m.prouver(autre, [4, 7]);
    expect(await message(m.passer(autre, "pilote", "publiee", { signature_production: "signature-prod-essai" }))).toContain("Étapes manquantes : 4, 7");
  });

  it("[C-249] publication avant 7 jours de pilote : refusée", async () => {
    const m = monde();
    const id = m.ajouter();
    await m.jusquAuPilote(id);
    m.avancer(6);
    m.horloge.t += 23 * 3_600_000;
    expect(await message(m.passer(id, "pilote", "publiee", { signature_production: "signature-prod-essai" }))).toContain("Étapes manquantes : 9");
    m.horloge.t += 3_600_000;
    await m.passer(id, "pilote", "publiee", { signature_production: "signature-prod-essai" });
    expect((m.versions.get(id) as V).statut).toBe("publiee");
  });

  it("[C-249] le délai de 7 jours se compte sur passe_le du serveur, même si l'horloge de l'application est avancée", async () => {
    const m = monde();
    const id = m.ajouter();
    await m.jusquAuPilote(id);
    m.avancer(3);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    expect(await message(m.passer(id, "pilote", "publiee", { signature_production: "signature-prod-essai" }))).toContain("Étapes manquantes : 9");
    expect((m.versions.get(id) as V).statut).toBe("pilote");
  });

  it("[C-249] une erreur definitive pendant le pilote bloque la publication", async () => {
    const m = monde({ definitives: 1 });
    const id = m.ajouter();
    await m.jusquAuPilote(id);
    const debut = new Date(m.horloge.t);
    m.avancer(8);
    expect(await message(m.passer(id, "pilote", "publiee", { signature_production: "signature-prod-essai" }))).toContain("Étapes manquantes : 9");
    expect(m.erreurs.appels).toEqual([{ id, depuis: debut }]);
    m.erreurs.definitives = 0;
    await m.passer(id, "pilote", "publiee", { signature_production: "signature-prod-essai" });
    expect((m.versions.get(id) as V).statut).toBe("publiee");
  });

  it("[C-249] un passage recette → pilote rangé alors que la version était encore en recette ne fait pas courir les 7 jours", async () => {
    const m = monde();
    const id = m.ajouter();
    m.prouver(id, [1, 2, 3, 5, 8]);
    await m.passer(id, "brouillon", "recette");
    m.forger(id, "recette", "pilote");
    m.prouver(id, [4, 7]);
    m.avancer(8);
    await m.passer(id, "recette", "pilote");
    expect(await message(m.passer(id, "pilote", "publiee", { signature_production: "signature-prod-essai" }))).toContain("Étapes manquantes : 9");
    m.avancer(7);
    await m.passer(id, "pilote", "publiee", { signature_production: "signature-prod-essai" });
    expect((m.versions.get(id) as V).statut).toBe("publiee");
  });

  it("[B-499] publication sans temps de réponse mesuré : refusée", async () => {
    const m = monde();
    const id = m.ajouter();
    m.prouver(id, [1, 2, 3, 4, 5, 8]);
    m.forger(id, "brouillon", "recette", m.horloge.t);
    m.forger(id, "recette", "pilote", m.horloge.t);
    (m.versions.get(id) as V).statut = "pilote";
    m.avancer(8);
    expect(await message(m.passer(id, "pilote", "publiee", { signature_production: "signature-prod-essai" }))).toContain("Étapes manquantes : 7");
  });

  it("[C-250] la publication range la preuve de l'étape 10 (drapeau du rapport mensuel) dans la même transaction que le passage", async () => {
    const m = monde();
    const id = m.ajouter();
    await m.jusquAuPilote(id);
    m.avancer(7);
    expect(await message(m.passer(id, "pilote", "publiee"))).toContain("Étapes manquantes : 10");
    expect(m.preuves.some((p) => p.etape === 10)).toBe(false);
    await m.passer(id, "pilote", "publiee", { signature_production: "signature-prod-essai" });
    const p10 = m.preuves.find((p) => p.etape === 10);
    expect(p10).toMatchObject({ reference: "signature-prod-essai", contenu: { rapport_mensuel: true }, auteur: "equipe-essai", le: m.horloge.t, empreinte: m.empreinte(id) });
    expect(m.passages.at(-1)).toMatchObject({ depart: "pilote", arrivee: "publiee", le: m.horloge.t });
    expect(m.journal.at(-1)).toEqual({ action: "passage_version", parQui: "equipe-essai" });
  });

  it("[C-250] si la preuve de l'étape 10 échoue, le passage est annulé en entier", async () => {
    const m = monde({ echecEtape10: true });
    const id = m.ajouter();
    await m.jusquAuPilote(id);
    m.avancer(7);
    const avant = m.passages.length;
    await expect(m.passer(id, "pilote", "publiee", { signature_production: "signature-prod-essai" })).rejects.toThrow("panne simulée");
    expect((m.versions.get(id) as V).statut).toBe("pilote");
    expect(m.passages).toHaveLength(avant);
  });

  it("[C-240] un passage dont l'état de départ ou l'empreinte ne correspond pas à la version est refusé", async () => {
    const m = monde();
    const id = m.ajouter();
    m.prouver(id, [1, 2, 3, 5, 8]);
    expect(await message(m.passer(id, "recette", "pilote"))).toContain("L'état de départ ne correspond pas");
    expect(await message(m.cycle.passer(id, lireDemandePassage({ depart: "brouillon", vers: "recette", empreinte_sha256: H("autre") }), "equipe-essai"))).toContain("L'empreinte ne correspond pas");
    expect(await message(m.cycle.passer(randomUUID(), lireDemandePassage({ depart: "brouillon", vers: "recette", empreinte_sha256: H("x") }), "equipe-essai"))).toContain("Version introuvable");
    expect(m.passages).toHaveLength(0);
    expect((m.versions.get(id) as V).statut).toBe("brouillon");
  });

  it("[B-461] dépréciation sans date de fin : refusée", async () => {
    const m = monde();
    const id = m.ajouter("publiee");
    const sans = { ...m.demande(id, "publiee", "depreciee", { fin_annoncee_le: "2027-03-31" }), finAnnonceeLe: null };
    expect(await message(m.cycle.passer(id, sans, "equipe-essai"))).toContain("date de fin");
    await m.passer(id, "publiee", "depreciee", { fin_annoncee_le: "2027-03-31" });
    expect(m.passages.at(-1)).toMatchObject({ arrivee: "depreciee", fin: "2027-03-31" });
  });

  it("[B-462] retrait sans remplaçante : refusé", async () => {
    const m = monde();
    const id = m.ajouter("depreciee");
    const sans = { ...m.demande(id, "depreciee", "retiree", { remplacante_id: randomUUID(), prevenance_le: "2026-11-01" }), remplacanteId: null };
    expect(await message(m.cycle.passer(id, sans, "equipe-essai"))).toContain("remplaçante");
    expect((m.versions.get(id) as V).statut).toBe("depreciee");
  });

  it("[B-462] retrait refusé si la remplaçante n'est pas une version publiee de la même automatisation ou si la date de prévenance n'est pas passée", async () => {
    const m = monde();
    const id = m.ajouter("depreciee");
    const cas: [string, string | undefined, string][] = [
      ["brouillon", "auto-1", "publiée"],
      ["retiree", "auto-1", "publiée"],
      ["publiee", "auto-2", "même automatisation"],
    ];
    for (const [statut, automatisationId, attendu] of cas) {
      const r = m.ajouter(statut as Statut, { automatisationId: automatisationId as string });
      expect(await message(m.passer(id, "depreciee", "retiree", { remplacante_id: r, prevenance_le: "2026-11-01" }))).toContain(attendu);
    }
    expect(await message(m.passer(id, "depreciee", "retiree", { remplacante_id: randomUUID(), prevenance_le: "2026-11-01" }))).toContain("publiée");
    expect(await message(m.passer(id, "depreciee", "retiree", { remplacante_id: id, prevenance_le: "2026-11-01" }))).toContain("publiée");
    const bonne = m.ajouter("publiee");
    expect(await message(m.passer(id, "depreciee", "retiree", { remplacante_id: bonne, prevenance_le: "2026-11-11" }))).toContain("prévenance");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    expect(await message(m.passer(id, "depreciee", "retiree", { remplacante_id: bonne, prevenance_le: "2026-11-11" }))).toContain("prévenance");
    vi.useRealTimers();
    expect((m.versions.get(id) as V).statut).toBe("depreciee");
    await m.passer(id, "depreciee", "retiree", { remplacante_id: bonne, prevenance_le: "2026-11-10" });
    expect(m.passages.at(-1)).toMatchObject({ arrivee: "retiree", remplacante: bonne, prevenance: "2026-11-10" });
  });

  it("[A-306] modifier une version publiée : refusé", async () => {
    const m = monde();
    const id = m.ajouter("publiee");
    const preuve = lireDemandePreuve({ etape: 2, empreinte_sha256: m.empreinte(id), reference: "prototype-essai" });
    expect(await message(m.cycle.deposer(id, preuve, "equipe-essai"))).toContain("figée");
    for (const vers of ["recette", "brouillon", "pilote", "retiree"] as Statut[]) expect(await message(m.passer(id, "publiee", vers))).toContain("Passage non permis");
    expect(m.preuves).toHaveLength(0);
    expect(m.passages).toHaveLength(0);
  });

  it("[C-310] aucune version importée n'atteint publiee sans recette ni pilote (chaîne complète, horloge simulée)", async () => {
    const m = monde();
    const id = m.ajouter();
    const publier = () => m.passer(id, "pilote", "publiee", { signature_production: "signature-prod-essai" });
    expect(await message(m.passer(id, "brouillon", "publiee"))).toContain("Passage non permis");
    m.prouver(id, [1, 2, 3, 5, 8]);
    await m.passer(id, "brouillon", "recette");
    expect(await message(publier())).toContain("L'état de départ ne correspond pas");
    m.prouver(id, [4, 7]);
    await m.passer(id, "recette", "pilote");
    expect(await message(publier())).toContain("Étapes manquantes : 9");
    m.avancer(7);
    await publier();
    await m.passer(id, "publiee", "depreciee", { fin_annoncee_le: "2027-06-30" });
    expect(m.passages.map((p) => `${p.depart}>${p.arrivee}`)).toEqual(["brouillon>recette", "recette>pilote", "pilote>publiee", "publiee>depreciee"]);
    expect(m.journal).toHaveLength(4);
  });
});

describe("cycle de vie : preuves côté serveur", () => {
  const rapport = (extra: Record<string, unknown> = {}) => ({
    module: "module-essai",
    version: "1.0.0",
    cas: [{ id: "cas-1", categorie: "nominal", reussi: true }],
    determinisme: [{ etape: "relecture", reussi: true }],
    hostile: { demandes: { refusees: 1, brouillons: 0, automatiques: 0 }, appelsConnecteur: 0, violations: 0 },
    totaux: { reussis: 2, echoues: 0 },
    codeSortie: 0,
    ...extra,
  });
  const etape4 = (m: ReturnType<typeof monde>, id: string, extra: Record<string, unknown> = {}) => lireDemandePreuve({ etape: 4, empreinte_sha256: m.empreinte(id), rapport: rapport(extra) });

  it("[C-202] modeles_testes est copié du rapport du harnais pendant la recette, jamais saisi à la main", async () => {
    const m = monde();
    const id = m.ajouter("recette");
    await m.cycle.deposer(id, etape4(m, id, { modeles: ["modele-essai-1", "modele-essai-2"] }), "equipe-essai");
    expect((m.versions.get(id) as V).modeles).toEqual(["modele-essai-1", "modele-essai-2"]);
    expect(m.appelsModeles).toEqual([["modele-essai-1", "modele-essai-2"]]);
    expect(m.preuves[0]).toMatchObject({ etape: 4, empreinte: m.empreinte(id), contenu: {} });
    // Une preuve d'une autre étape n'écrit jamais la liste ; un rapport sans liste la laisse nulle (aucun modèle proposé).
    const neuve = m.ajouter("recette");
    await m.cycle.deposer(neuve, lireDemandePreuve({ etape: 2, empreinte_sha256: m.empreinte(neuve), reference: "prototype-essai" }), "equipe-essai");
    const sans = m.ajouter("recette");
    await m.cycle.deposer(sans, etape4(m, sans), "equipe-essai");
    expect((m.versions.get(neuve) as V).modeles).toBeNull();
    expect((m.versions.get(sans) as V).modeles).toBeNull();
    expect(m.appelsModeles).toHaveLength(1);
  });

  it("[C-202] la liste du rapport n'est pas écrite en brouillon, ni depuis un rapport rouge ou d'un autre module", async () => {
    const m = monde();
    const brouillon = m.ajouter("brouillon");
    expect(await message(m.cycle.deposer(brouillon, etape4(m, brouillon, { modeles: ["modele-essai-1"] }), "equipe-essai"))).toContain("recette");
    const id = m.ajouter("recette");
    expect(await message(m.cycle.deposer(id, etape4(m, id, { codeSortie: 1, modeles: ["modele-essai-1"] }), "equipe-essai"))).toContain("rapport");
    expect(await message(m.cycle.deposer(id, etape4(m, id, { module: "autre-module" }), "equipe-essai"))).toContain("rapport");
    expect(await message(m.cycle.deposer(id, etape4(m, id, { version: "9.9.9" }), "equipe-essai"))).toContain("rapport");
    expect(m.appelsModeles).toHaveLength(0);
    expect(m.preuves).toHaveLength(0);
  });

  it("[C-240] une preuve doublon, ou pour une autre empreinte, est refusée", async () => {
    const m = monde();
    const id = m.ajouter("brouillon");
    const p = lireDemandePreuve({ etape: 2, empreinte_sha256: m.empreinte(id), reference: "prototype-essai" });
    await m.cycle.deposer(id, p, "equipe-essai");
    expect(await message(m.cycle.deposer(id, p, "equipe-essai"))).toContain("déjà rangée");
    expect(await message(m.cycle.deposer(id, lireDemandePreuve({ etape: 3, empreinte_sha256: H("autre"), reference: "schema-essai" }), "equipe-essai"))).toContain("L'empreinte ne correspond pas");
    expect(await message(m.cycle.deposer(randomUUID(), p, "equipe-essai"))).toContain("Version introuvable");
    expect(m.preuves).toHaveLength(1);
  });

  it("[B-499] la preuve de l'étape 7 range le temps de réponse mesuré et la fiche catalogue", async () => {
    const m = monde();
    const id = m.ajouter("recette");
    await m.cycle.deposer(id, lireDemandePreuve({ etape: 7, empreinte_sha256: m.empreinte(id), mesure_ms: 1200, notes_de_version: "Première version", fiche: { benefice: "Gain de temps", prerequis: "Messagerie reliée", temps_gagne: "Dix minutes", prix: "[montant]" } }), "equipe-essai");
    expect(m.preuves[0]).toMatchObject({ etape: 7, mesure: 1200, contenu: { notes_de_version: "Première version", fiche: { prix: "[montant]" } } });
  });
});

describe("route des versions (T4-27b)", () => {
  const ID = randomUUID();
  const EMP = H("route");
  const passage = { depart: "recette", vers: "pilote", empreinte_sha256: EMP };
  function serveur(o: { ouvert?: boolean; present?: boolean; equipe?: boolean } = {}) {
    const appels: string[] = [];
    const cycle = {
      async passer(id: string, d: { vers: string }, acteur: string) { appels.push(`passer ${id} ${d.vers} ${acteur}`); return { versionId: id, statut: d.vers }; },
      async deposer(id: string, d: { etape: number }, acteur: string) { appels.push(`deposer ${id} ${d.etape} ${acteur}`); return { etape: d.etape }; },
    };
    const authentifier = async (r: { headers: Record<string, unknown> }) => {
      if (r.headers["x-test-acteur"] !== "equipe") throw new ErreurApi("action_interdite", "Réservé à l'équipe.");
      return { acteur: "equipe-essai" };
    };
    const app = construireServeur(o.present === false ? {} : { versionsCatalogue: { ouvert: o.ouvert ?? true, cycle: cycle as never, authentifier: authentifier as never } });
    const poster = (chemin: string, corps: unknown, equipe = true) => app.inject({ method: "POST", url: `/api/catalogue/v1/versions/${ID}/${chemin}`, payload: corps as object, headers: equipe ? { "x-test-acteur": "equipe" } : {} });
    return { app, appels, poster };
  }

  it("[A-305] la route des versions n'existe pas tant que l'interrupteur est fermé, et refuse un appel sans jeton d'équipe", async () => {
    const absent = serveur({ present: false });
    expect((await absent.poster("passages", passage)).statusCode).toBe(404);
    expect((await absent.poster("preuves", {})).statusCode).toBe(404);

    const ferme = serveur({ ouvert: false });
    expect((await ferme.poster("passages", passage)).statusCode).toBe(503);
    expect((await ferme.poster("preuves", { etape: 2 })).statusCode).toBe(503);
    expect(ferme.appels).toEqual([]);

    const ouvert = serveur();
    expect((await ouvert.poster("passages", passage, false)).statusCode).toBe(403);
    expect((await ouvert.poster("preuves", { etape: 2, empreinte_sha256: EMP, reference: "prototype-essai" }, false)).statusCode).toBe(403);
    expect(ouvert.appels).toEqual([]);

    const r = await ouvert.poster("passages", passage);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ version_id: ID, statut: "pilote" });
    const p = await ouvert.poster("preuves", { etape: 2, empreinte_sha256: EMP, reference: "prototype-essai" });
    expect(p.statusCode).toBe(201);
    expect(ouvert.appels).toEqual([`passer ${ID} pilote equipe-essai`, `deposer ${ID} 2 equipe-essai`]);
  });

  it("[C-240] la route refuse un corps hors schéma ou un identifiant qui n'est pas un UUID, sans appeler la machine", async () => {
    const s = serveur();
    expect((await s.poster("passages", { ...passage, statut: "publiee" })).statusCode).toBe(400);
    expect((await s.poster("preuves", { etape: 9, empreinte_sha256: EMP, reference: "x-1" })).statusCode).toBe(400);
    const mauvais = await s.app.inject({ method: "POST", url: "/api/catalogue/v1/versions/pas-un-uuid/passages", payload: passage, headers: { "x-test-acteur": "equipe" } });
    expect(mauvais.statusCode).toBe(400);
    expect(s.appels).toEqual([]);
  });

  it("[C-240] une refus de la machine sort en 422 avec les étapes manquantes, sans autre donnée", async () => {
    const app = construireServeur({
      versionsCatalogue: {
        ouvert: true,
        authentifier: (async () => ({ acteur: "equipe-essai" })) as never,
        cycle: { passer: async () => { throw new ErreurApi("regle_metier", "Étapes manquantes : 4."); }, deposer: async () => ({ etape: 4 }) } as never,
      },
    });
    const r = await app.inject({ method: "POST", url: `/api/catalogue/v1/versions/${ID}/passages`, payload: passage });
    expect(r.statusCode).toBe(422);
    expect(r.json().erreur).toMatchObject({ code: "regle_metier", message: "Étapes manquantes : 4." });
  });
});
