import { describe, expect, it } from "vitest";
import { COLONNES_CSV, empreinteCsv, neutraliser, versCsv } from "./export-csv.js";
import { filtrerClients, paginer, versDto, VUE_PRETE_ABONNEMENTS, type LigneClient } from "./liste.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const L = (n: number, p: Partial<LigneClient> = {}): LigneClient => ({ id: id(n), nom: "Lemoine Rénovation", formule: "abonnement", sante: "bon", statut: "client", apporteur: null, modeleIa: null, metier: null, ...p });
const JEU: LigneClient[] = [
  L(1, { nom: "Lemoine Rénovation", formule: "abonnement", sante: "bon", metier: "batiment", apporteur: "Immobilière Marceau", modeleIa: "modele-a" }),
  L(2, { nom: "Boulangerie Rivoire", formule: "achat", sante: "a_verifier", metier: "alimentation", statut: "prospect" }),
  L(3, { nom: "Garage Fontaine", formule: "installation_maintenance", sante: "urgent", metier: "automobile", modeleIa: "modele-b" }),
  L(4, { nom: "Atelier Bertin", formule: "abonnement", sante: "bon", metier: "batiment", statut: "ancien_client" }),
];
const noms = (l: LigneClient[]) => l.map((x) => x.nom);

describe("liste des clients", () => {
  it("[B-005] la recherche plein texte et chaque filtre réduisent la liste", () => {
    expect(filtrerClients(JEU, {})).toHaveLength(4);
    expect(noms(filtrerClients(JEU, { q: "renovation" }))).toEqual(["Lemoine Rénovation"]);
    expect(noms(filtrerClients(JEU, { q: "MARCEAU" }))).toEqual(["Lemoine Rénovation"]);
    expect(noms(filtrerClients(JEU, { formule: "achat" }))).toEqual(["Boulangerie Rivoire"]);
    expect(noms(filtrerClients(JEU, { sante: "urgent" }))).toEqual(["Garage Fontaine"]);
    expect(noms(filtrerClients(JEU, { statut: "ancien_client" }))).toEqual(["Atelier Bertin"]);
    expect(noms(filtrerClients(JEU, { apporteur: "Immobilière Marceau" }))).toEqual(["Lemoine Rénovation"]);
    expect(noms(filtrerClients(JEU, { modele_ia: "modele-b" }))).toEqual(["Garage Fontaine"]);
    expect(noms(filtrerClients(JEU, { formule: "abonnement", sante: "bon", q: "atelier" }))).toEqual(["Atelier Bertin"]);
    expect(filtrerClients(JEU, { q: "inconnu" })).toEqual([]);
  });

  it("[B-342] le filtre par métier fonctionne", () => {
    expect(noms(filtrerClients(JEU, { metier: "batiment" }))).toEqual(["Atelier Bertin", "Lemoine Rénovation"]);
    expect(filtrerClients(JEU, { metier: "sans-metier" })).toEqual([]);
  });

  it("[B-319] chaque ligne porte le badge de sa formule", () => {
    const badges = JEU.map((l) => versDto(l).badge_formule);
    expect(badges).toEqual(["Abonnement", "Achat", "Installation et maintenance", "Abonnement"]);
    expect(versDto(JEU[0]!).formule).toBe("abonnement");
  });

  it("[B-320] la vue « Mes abonnements » existe", () => {
    expect(VUE_PRETE_ABONNEMENTS).toMatchObject({ id: "mes-abonnements", nom: "Mes abonnements", filtres: { formule: "abonnement" } });
    expect(noms(filtrerClients(JEU, VUE_PRETE_ABONNEMENTS.filtres))).toEqual(["Atelier Bertin", "Lemoine Rénovation"]);
  });

  it("[B-231] 5 000 clients : premier affichage en moins d'une seconde", () => {
    const noms5 = ["Lemoine Rénovation", "Immobilière Marceau", "Boulangerie Rivoire", "Garage Fontaine", "Atelier Bertin"];
    const gros = Array.from({ length: 5000 }, (_, i) => L(i + 1, { nom: `${noms5[i % 5]} ${i}`, metier: i % 2 ? "batiment" : "automobile" }));
    const debut = performance.now();
    const p = paginer(filtrerClients(gros, { q: "garage" }), undefined, 50);
    expect(performance.now() - debut).toBeLessThan(1000);
    expect(p.lignes).toHaveLength(50);
    expect(p.curseurSuivant).not.toBeNull();
  });

  it("[B-175] la pagination par curseur ne saute ni ne répète aucune ligne", () => {
    const tout = filtrerClients(JEU, {});
    const a = paginer(tout, undefined, 3);
    const b = paginer(tout, a.curseurSuivant ?? undefined, 3);
    expect([...a.lignes, ...b.lignes]).toEqual(tout);
    expect(b.curseurSuivant).toBeNull();
    expect(() => paginer(tout, "pas-un-curseur", 3)).toThrow();
  });
});

describe("export CSV", () => {
  it("[C-579] une cellule commençant par = est neutralisée", () => {
    for (const piege of ["=1+1", "+1", "-1", "@SOMME(A1)", "\t=1", "\r=1"]) expect(neutraliser(piege), piege).toBe(`'${piege}`);
    expect(neutraliser("Atelier Bertin")).toBe("Atelier Bertin");
    const csv = versCsv([L(1, { nom: '=HYPERLINK("http://exemple.test")' })]);
    expect(csv).not.toMatch(/(^|,)"?=/m);
  });

  it("[C-579] le CSV n'a que les colonnes de la liste, entre guillemets, et une empreinte stable", () => {
    const csv = versCsv(JEU);
    const lignes = csv.trimEnd().split("\r\n");
    expect(lignes[0]).toBe(COLONNES_CSV.join(","));
    expect(lignes).toHaveLength(5);
    expect(csv).toContain('"Lemoine Rénovation"');
    expect(empreinteCsv(csv)).toMatch(/^[0-9a-f]{64}$/);
    expect(empreinteCsv(csv)).toBe(empreinteCsv(versCsv(JEU)));
  });
});
