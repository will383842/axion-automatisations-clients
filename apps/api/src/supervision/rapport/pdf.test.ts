import { describe, expect, it } from "vitest";
import { calculerMesures, type AgregatJour, type EntreeInstance } from "./calculs.js";
import { ExempleHorsClient, type ExempleRapport } from "./exemple.js";
import { choisirConseil, composerContenu, preparerPdf, RapportRefuse, type ContenuRapport, type EntreeRapport, type PortsPdf } from "./pdf.js";

const TA = "11111111-1111-4111-8111-111111111111";
const TB = "22222222-2222-4222-8222-222222222222";
const MOIS = "2026-10";
const agr = (t: string, j: string, nombre: number, echecs = 0): AgregatJour => ({ tenantId: t, jour: j, nombre, echecs });
const inst = (t: string, marque: string): EntreeInstance => ({
  tenantId: t, code: `auto-${marque}`, libelle: `Libellé ${marque}`, minutesParElement: 6,
  agregats: [agr(t, "2026-09-10", 10), agr(t, "2026-10-10", 20, 1)],
});
const entree = (t: string, marque: string, p: Partial<EntreeRapport> = {}): EntreeRapport => ({
  tenantId: t, raisonSociale: `Société ${marque}`, mois: MOIS, instances: [inst(t, marque)],
  candidates: [{ code: `conseil-${marque}`, libelle: `Conseil ${marque}`, etape10RapportMensuel: true, famillesCompatibles: ["courriel"] }],
  famillesReliees: ["courriel"], codesActifs: [`auto-${marque}`], ...p,
});
const sansExemple: ExempleRapport = { lire: async () => undefined };
const ports = (rendus: ContenuRapport[] = [], exemple: ExempleRapport = sansExemple): PortsPdf => ({
  exemple, rendre: async (c) => { rendus.push(c); return new Uint8Array([37, 80, 68, 70]); },
});

describe("contenu du rapport", () => {
  it("[B-408] le contenu porte heures gagnées, volume, fiabilité, comparaison, prochaine automatisation, et l'exemple ou son omission", () => {
    const c = composerContenu(entree(TA, "MARQUE-A"), calculerMesures(TA, entree(TA, "MARQUE-A").instances, MOIS), {
      tenantId: TA, titre: "Devis relancé", texte: "Un devis a été relancé.",
    });
    expect(c.mesures.heures).toEqual({ etat: "mesure", minutes: 120 });
    expect(c.mesures.volume).toBe(20);
    expect(c.mesures.fiabilite).toEqual({ etat: "mesure", pointsDeBase: 9500 });
    expect(c.mesures.comparaison.etat).toBe("mesure");
    expect(c.conseil).toEqual({ code: "conseil-MARQUE-A", libelle: "Conseil MARQUE-A" });
    expect(c.exemple).toEqual({ titre: "Devis relancé", texte: "Un devis a été relancé." });
    const sans = composerContenu(entree(TA, "MARQUE-A"), calculerMesures(TA, entree(TA, "MARQUE-A").instances, MOIS), undefined);
    expect("exemple" in sans).toBe(false);
    expect(sans.notes.join(" ")).toContain("temps actuel par élément");
  });

  it("[B-408] conseil : seule une automatisation publiée avec étape 10 rapport_mensuel = true, compatible avec un outil relié actif, non active chez le client ; tri par code ; aucune → rubrique omise", () => {
    const base = { famillesCompatibles: ["courriel"], etape10RapportMensuel: true };
    const candidates = [
      { code: "zeta", libelle: "Z", ...base },
      { code: "alpha-sans-drapeau", libelle: "A1", famillesCompatibles: ["courriel"], etape10RapportMensuel: false },
      { code: "alpha-autre-outil", libelle: "A2", famillesCompatibles: ["compta"], etape10RapportMensuel: true },
      { code: "alpha-deja-active", libelle: "A3", ...base },
      { code: "beta", libelle: "B", ...base },
    ];
    expect(choisirConseil({ candidates, famillesReliees: ["courriel"], codesActifs: ["alpha-deja-active"] })).toEqual({ code: "beta", libelle: "B" });
    expect(choisirConseil({ candidates, famillesReliees: [], codesActifs: [] })).toBeUndefined();
    expect(choisirConseil({ candidates: [], famillesReliees: ["courriel"], codesActifs: [] })).toBeUndefined();
    // drapeau lu strictement : toute autre valeur que true exclut
    const flou = [{ code: "flou", libelle: "F", famillesCompatibles: ["courriel"], etape10RapportMensuel: "true" as unknown as boolean }];
    expect(choisirConseil({ candidates: flou, famillesReliees: ["courriel"], codesActifs: [] })).toBeUndefined();
  });

  it("[B-408] @isolation le contenu de A ne contient aucun identifiant ni aucune marque de B (deux jeux complets passés à la suite à la même fonction)", async () => {
    const rendus: ContenuRapport[] = [];
    const exemples: ExempleRapport = { lire: async (t) => ({ tenantId: t, titre: `titre ${t === TA ? "MARQUE-A" : "MARQUE-B"}`, texte: "texte" }) };
    await preparerPdf(ports(rendus, exemples), entree(TB, "MARQUE-B"));
    await preparerPdf(ports(rendus, exemples), entree(TA, "MARQUE-A"));
    const [b, a] = rendus.map((c) => JSON.stringify(c));
    expect(a).toContain("MARQUE-A");
    expect(a).not.toContain("MARQUE-B");
    expect(a).not.toContain(TB);
    expect(b).not.toContain("MARQUE-A");
    expect(b).not.toContain(TA);
  });

  it("[B-408] exemple d'un autre client → erreur, rien n'est rendu", async () => {
    const rendus: ContenuRapport[] = [];
    const mauvais: ExempleRapport = { lire: async () => ({ tenantId: TB, titre: "MARQUE-B", texte: "MARQUE-B" }) };
    await expect(preparerPdf(ports(rendus, mauvais), entree(TA, "MARQUE-A"))).rejects.toBeInstanceOf(ExempleHorsClient);
    expect(rendus).toEqual([]);
  });

  it("[B-408] aucun prix, coût, UIA ni marge : l'entrée n'a pas de champ de coût ; le texte sérialisé ne contient ni « € », « UIA », « coût », « marge » ni « micro »", async () => {
    const rendus: ContenuRapport[] = [];
    await preparerPdf(ports(rendus), entree(TA, "MARQUE-A"));
    const texte = JSON.stringify(rendus[0]);
    for (const interdit of ["€", "UIA", "coût", "cout", "marge", "micro", "prix"]) expect(texte.toLowerCase()).not.toContain(interdit.toLowerCase());
    const cles = new Set<string>();
    const parcourir = (v: unknown): void => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { cles.add(k); parcourir(x); } };
    parcourir(rendus[0]);
    expect([...cles].filter((k) => /cout|prix|uia|marge/i.test(k))).toEqual([]);
  });

  it("[B-408] raison sociale « <b>Boulangerie</b>\\u0000 » : passée comme texte, sans caractère de contrôle, bornée à 200", async () => {
    const rendus: ContenuRapport[] = [];
    await preparerPdf(ports(rendus), entree(TA, "MARQUE-A", { raisonSociale: "<b>Boulangerie</b>\u0000\u0007" }));
    expect(rendus[0]?.raisonSociale).toBe("<b>Boulangerie</b>");
    await preparerPdf(ports(rendus), entree(TA, "MARQUE-A", { raisonSociale: "é".repeat(300) }));
    expect(Array.from(rendus[1]?.raisonSociale ?? "").length).toBe(200);
    await expect(preparerPdf(ports(rendus), entree(TA, "MARQUE-A", { raisonSociale: "\u0000 " }))).rejects.toBeInstanceOf(RapportRefuse);
  });

  it("[B-408] le PDF rendu est celui du port, rendu une seule fois, avec le contenu composé", async () => {
    const rendus: ContenuRapport[] = [];
    const r = await preparerPdf(ports(rendus), entree(TA, "MARQUE-A"));
    expect(rendus).toHaveLength(1);
    expect(r.octets).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(r.contenu).toBe(rendus[0]);
  });

  it("[C-058] aucune comparaison avec un métier : pas de clé metier, naf, moyenne, mediane ni autres_clients dans le contenu en V1", async () => {
    const rendus: ContenuRapport[] = [];
    await preparerPdf(ports(rendus), entree(TA, "MARQUE-A"));
    const cles: string[] = [];
    const parcourir = (v: unknown): void => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { cles.push(k.toLowerCase()); parcourir(x); } };
    parcourir(rendus[0]);
    for (const interdit of ["metier", "naf", "moyenne", "mediane", "autres_clients", "autresclients", "secteur"]) expect(cles).not.toContain(interdit);
  });
});
