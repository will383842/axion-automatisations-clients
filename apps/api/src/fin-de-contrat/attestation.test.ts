import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ETAPES, creerMachineFin, planifierTaches, type Dossier } from "./machine.js";
import { etapeMiseALEcart } from "./mettre-a-l-ecart.js";
import { etapeAttestation, produireAttestation, texteDe, type ContenuAttestation, type NatureAttestation, type PortsAttestation } from "./attestation.js";

const A = "11111111-1111-4111-8111-111111111111";
const FIN = "55555555-5555-4555-8555-555555555555";
const JOUR = 86_400_000;
const DEBUT_EXPORT = new Date("2027-01-10T00:00:00Z");
const J30 = new Date(DEBUT_EXPORT.getTime() + 30 * JOUR);
const GARDES = ["base", "compartiment", "sauvegardes", "cle_client", "identifiants", "cle_ia"] as const;
const EFFACES = [...GARDES, "coffre", "roles"] as const;
const objet = (type: string, i: number) => ({ type, date: new Date(`2027-02-0${(i % 8) + 1}T08:00:00Z`), empreinte: `empreinte-${type}` });

function monter(o: { maintenant?: Date; exportDepuis?: Date | null; effacementDecide?: "demande" | "proposition" | "aucune"; avis?: Date | null; sansCleIa?: boolean; effacementFait?: boolean } = {}) {
  const contenus: ContenuAttestation[] = [];
  const rangees: { nature: NatureAttestation; octets: Uint8Array; empreinte: string; titreContrat: string }[] = [];
  const envois: { nature: NatureAttestation; cle: string }[] = [];
  const decision = o.effacementDecide ?? "aucune";
  const p: PortsAttestation = {
    maintenant: () => o.maintenant ?? new Date(J30.getTime() + JOUR),
    fin: async (t, id) => (t === A && id === FIN ? { identifiantConsole: "client-0001", raisonSociale: "Boulangerie Rivoire", dateFin: "2027-01-10", exportDisponibleDepuis: o.exportDepuis === undefined ? DEBUT_EXPORT : o.exportDepuis, delaiPropositionMois: 24 } : undefined),
    compteRendu: async (_t, _id, nature) => {
      if (nature === "effacement" && o.effacementFait === false) return undefined;
      const types = nature === "effacement" ? EFFACES : GARDES.filter((x) => !(o.sansCleIa && x === "cle_ia"));
      return { objets: types.map(objet), signataire: "Camille Lefèvre (administratrice)", confirmeLe: J30 };
    },
    decisionEffacement: async () => (decision === "aucune" ? undefined : { source: decision, decideLe: J30, avisClientLe: o.avis === undefined ? new Date("2027-01-20T00:00:00Z") : o.avis }),
    piecesGardees: async () => [{ libelle: "Factures et pièces comptables", dureeMinimale: "durée légale de conservation" }, { libelle: "Contrats et preuves", dureeMinimale: "durée légale de conservation" }, { libelle: "Journaux de connexion", dureeMinimale: "durée légale de conservation" }],
    rendre: async (c) => { contenus.push(c); return new TextEncoder().encode(`%PDF-fictif ${texteDe(c)}`); },
    ranger: async (r) => { rangees.push({ nature: r.nature, octets: r.octets, empreinte: r.empreinteSha256, titreContrat: r.titreContrat }); return { reference: `suivi/attestations/${r.nature}.pdf` }; },
    envoyer: async (m) => void envois.push({ nature: m.nature, cle: m.cle }),
    tracer: async () => undefined,
  };
  return { p, contenus, rangees, envois };
}

describe("attestation de mise à l'écart", () => {
  it("[C-054] l'attestation de mise à l'écart liste les objets gardés, les dates, les empreintes et le signataire", async () => {
    const { p, contenus } = monter();
    await produireAttestation(p, A, FIN, "mise_a_l_ecart");
    const c = contenus[0]!;
    expect(c.identifiantConsole).toBe("client-0001");
    expect(c.raisonSociale).toBe("Boulangerie Rivoire");
    expect(c.objets).toHaveLength(6);
    for (const o of c.objets) { expect(o.date).toMatch(/^\d{4}-\d{2}-\d{2}/); expect(o.empreinte).toMatch(/^empreinte-/); }
    expect(c.signataire).toBe("Camille Lefèvre (administratrice)");
  });
  it("[A-258] l'attestation dit ce qui reste et jusqu'à quand, et est rangée dans Contrat", async () => {
    const { p, rangees, envois } = monter();
    await produireAttestation(p, A, FIN, "mise_a_l_ecart");
    expect(rangees).toHaveLength(1);
    expect(rangees[0]!.titreContrat).toBe("attestation de mise à l'écart");
    expect(envois).toHaveLength(1);
    const c = (await (async () => { const m = monter(); await produireAttestation(m.p, A, FIN, "mise_a_l_ecart"); return m.contenus[0]!; })());
    expect(texteDe(c)).toMatch(/rien n'a été effacé/i);
    expect(texteDe(c)).toMatch(/jusqu'à/i);
  });
  it("[A-258] le texte de l'attestation de mise à l'écart ne contient ni « supprimé » ni « détruit »", async () => {
    const { p, contenus } = monter();
    await produireAttestation(p, A, FIN, "mise_a_l_ecart");
    expect(texteDe(contenus[0]!)).not.toMatch(/supprimé|supprimée|détruit|détruite|detruit/i);
  });
  it("[A-259] aucune attestation J+65 n'est émise pour un client simplement mis à l'écart", async () => {
    expect((ETAPES as readonly string[]).join()).not.toMatch(/65|attestation/);
    const taches = planifierTaches(A, "2027-01-10", new Date("2027-01-01T00:00:00Z"));
    expect(taches.map((t) => t.jobId).join()).not.toMatch(/65|attestation/);
    const { p, rangees } = monter();
    await produireAttestation(p, A, FIN, "mise_a_l_ecart");
    expect(rangees.map((r) => r.nature)).toEqual(["mise_a_l_ecart"]);
  });
  it("[C-715] l'attestation de mise à l'écart cite le délai de proposition de suppression (réglage du client) et liste les pièces gardées sans date de suppression avec leurs durées minimales", async () => {
    const { p, contenus } = monter();
    await produireAttestation(p, A, FIN, "mise_a_l_ecart");
    const t = texteDe(contenus[0]!);
    expect(t).toMatch(/24 mois/);
    for (const l of ["Factures et pièces comptables", "Contrats et preuves", "Journaux de connexion"]) expect(t).toContain(l);
    expect(t).toMatch(/durée légale de conservation/);
    const m = monter();
    const reglage = { ...m.p, fin: async (t2: string, id: string) => ({ ...(await m.p.fin(t2, id))!, delaiPropositionMois: 18 }) };
    await produireAttestation(reglage, A, FIN, "mise_a_l_ecart");
    expect(texteDe(m.contenus[0]!)).toMatch(/18 mois/);
  });
  it("[B-168] l'attestation mentionne la clé d'IA du client désactivée et conservée", async () => {
    const { p, contenus } = monter();
    await produireAttestation(p, A, FIN, "mise_a_l_ecart");
    expect(texteDe(contenus[0]!)).toMatch(/clé d'IA.*désactivée.*conservée/is);
    const m = monter({ sansCleIa: true });
    await expect(produireAttestation(m.p, A, FIN, "mise_a_l_ecart")).rejects.toThrow(/compte_rendu_incomplet/);
    expect(m.rangees).toEqual([]);
  });
  it("[C-054] l'empreinte du PDF rangé correspond au fichier", async () => {
    const { p, rangees } = monter();
    const r = await produireAttestation(p, A, FIN, "mise_a_l_ecart");
    expect(rangees[0]!.empreinte).toBe(createHash("sha256").update(rangees[0]!.octets).digest("hex"));
    expect(r.empreinteSha256).toBe(rangees[0]!.empreinte);
  });
  it("[B-376] l'export est resté disponible 30 jours avant la mise à l'écart", async () => {
    const trop_tot = monter({ maintenant: new Date(J30.getTime() - 60_000) });
    await expect(produireAttestation(trop_tot.p, A, FIN, "mise_a_l_ecart")).rejects.toThrow(/export_moins_de_30_jours/);
    const jamais = monter({ exportDepuis: null });
    await expect(produireAttestation(jamais.p, A, FIN, "mise_a_l_ecart")).rejects.toThrow(/export_moins_de_30_jours/);
    expect(trop_tot.rangees.length + jamais.rangees.length + trop_tot.envois.length).toBe(0);
    const ok = monter({ maintenant: J30 });
    await produireAttestation(ok.p, A, FIN, "mise_a_l_ecart");
    expect(ok.rangees).toHaveLength(1);
  });
  it("[A-258] un autre client ou une fin de contrat inconnue est refusé", async () => {
    const { p } = monter();
    await expect(produireAttestation(p, "22222222-2222-4222-8222-222222222222", FIN, "mise_a_l_ecart")).rejects.toThrow(/fin_de_contrat_inconnue/);
  });
});

describe("attestation d'effacement", () => {
  it("[A-259] une attestation d'effacement sans décision enregistrée de Will est refusée", async () => {
    const { p, rangees, envois } = monter({ effacementDecide: "aucune" });
    await expect(produireAttestation(p, A, FIN, "effacement")).rejects.toThrow(/decision_effacement_absente/);
    expect(rangees.length + envois.length).toBe(0);
  });
  it("[A-258] après un effacement décidé, l'attestation d'effacement liste les objets effacés et ce qui reste", async () => {
    const { p, contenus, rangees } = monter({ effacementDecide: "demande" });
    await produireAttestation(p, A, FIN, "effacement");
    const c = contenus[0]!;
    expect(c.objets).toHaveLength(8);
    const t = texteDe(c);
    expect(t).toMatch(/effacé/i);
    expect(t).toMatch(/factures/i);
    expect(t).toMatch(/journal d'audit/i);
    expect(t).toMatch(/illisibles/i);
    expect(rangees[0]!.titreContrat).toBe("attestation d'effacement");
  });
  it("[A-258] un effacement non exécuté (pas de compte rendu d'effacer.ts) ne produit rien", async () => {
    const { p, rangees } = monter({ effacementDecide: "demande", effacementFait: false });
    await expect(produireAttestation(p, A, FIN, "effacement")).rejects.toThrow(/effacement_non_execute/);
    expect(rangees).toEqual([]);
  });
  it("[C-715] une attestation d'effacement est émise après l'acceptation d'une proposition à 24 mois, avec la date de l'avis envoyé au client", async () => {
    const { p, contenus } = monter({ effacementDecide: "proposition", avis: new Date("2027-01-20T00:00:00Z") });
    await produireAttestation(p, A, FIN, "effacement");
    expect(texteDe(contenus[0]!)).toContain("2027-01-20");
    const sans = monter({ effacementDecide: "proposition", avis: null });
    await expect(produireAttestation(sans.p, A, FIN, "effacement")).rejects.toThrow(/avis_client_absent/);
  });
});

describe("étape d'attestation dans la machine", () => {
  const dossier: Dossier = { dateFin: "2027-01-10", exportReference: "ref", exportTelechargeLe: null, preavis: { 1: { envoyeLe: null, accuse: null }, 20: { envoyeLe: null, accuse: null }, 27: { envoyeLe: null, accuse: null } } };
  it("[C-505] l'export est disponible 30 jours, puis la mise à l'écart et l'attestation de mise à l'écart suivent, dans cet ordre", async () => {
    const journal: string[] = [];
    let ecartee = false;
    const m = monter({ maintenant: J30 });
    const dejaRangees: string[] = [];
    const ecart = etapeMiseALEcart({
      gel: { gelActif: async () => false }, validations: async () => [], etatBase: async () => (ecartee ? "a_l_ecart" : "gelee"),
      retirerPgBouncer: async () => undefined, revoquerConnect: async () => undefined, lectureSeuleCompartiment: async () => undefined, desactiverIdentifiants: async () => undefined, desactiverCleIa: async () => undefined,
      marquerALEcart: async () => { journal.push("mise_a_l_ecart"); ecartee = true; }, alerter: async () => undefined, tracer: async () => undefined, maintenant: () => J30,
    });
    // La mise à l'écart de ce test est déjà confirmée : on la remplace par une étape qui journalise, l'attestation est la vraie.
    const ecartJournal = { ...ecart, dejaFait: ecart.dejaFait, faire: async () => { journal.push("mise_a_l_ecart"); ecartee = true; } };
    const attestation = etapeAttestation({ ...m.p, ranger: async (r) => { journal.push("attestation"); dejaRangees.push(r.nature); return { reference: "x" }; } }, { finDeContratId: () => FIN, dejaRangee: async (_t, n) => dejaRangees.includes(n), miseALEcartFaite: async () => ecartee });
    const machine = creerMachineFin({ etapes: [ecartJournal, attestation], dossier: async () => dossier, gel: { gelActif: async () => false }, alerter: async () => undefined, maintenant: () => J30 });
    expect(attestation.echeance(dossier).getTime()).toBeGreaterThanOrEqual(ecart.echeance(dossier).getTime());
    await machine.executer(A);
    expect(journal).toEqual(["mise_a_l_ecart", "attestation"]);
    await machine.executer(A);
    expect(journal).toEqual(["mise_a_l_ecart", "attestation"]);
  });
});
