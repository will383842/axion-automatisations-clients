import { describe, expect, it } from "vitest";
import { calculer } from "./calcul.js";

// Croisement des outils d'un client avec le catalogue (T3-17b). Entreprise fictive : Lemoine Rénovation.
const geler = <T>(v: T): T => {
  if (v && typeof v === "object") for (const x of Object.values(v)) geler(x);
  return Object.freeze(v);
};
const catalogue = [
  { code: "AUT-102", nom: "Relance de devis", familles: ["messagerie", "crm"] },
  { code: "AUT-101", nom: "Rappel de rendez-vous", familles: ["agenda"] },
  { code: "AUT-103", nom: "Courrier de bienvenue", familles: ["messagerie"] },
];
const connecteurs = [
  { famille: "messagerie", outil: "microsoft_365" },
  { famille: "agenda", outil: "microsoft_365" },
];
const ent = (o: Partial<Parameters<typeof calculer>[0]> = {}) => ({ outils: [], catalogue, connecteurs, gammes: {}, ...o });
const codes = (l: { code: string }[]) => l.map((x) => x.code);

describe("compatibilité des outils et des automatisations", () => {
  it("[A-410] le croisement classe chaque automatisation en compatible, à créer ou impossible", () => {
    const r = calculer(ent({ outils: [{ famille: "messagerie", outil: "microsoft_365" }, { famille: "agenda", outil: "microsoft_365" }, { famille: "crm", outil: "logiciel_devis" }] }));
    expect(codes(r.compatibles)).toEqual(["AUT-101", "AUT-103"]);
    expect(codes(r.a_creer)).toEqual(["AUT-102"]);
    expect(codes(r.impossibles)).toEqual([]);
    const r2 = calculer(ent({ outils: [{ famille: "messagerie", outil: "microsoft_365" }] }));
    expect(codes(r2.compatibles)).toEqual(["AUT-103"]);
    expect(codes(r2.impossibles)).toEqual(["AUT-101", "AUT-102"]);
  });

  it("[A-410] une famille sans outil rend impossible même si les autres familles sont couvertes", () => {
    const r = calculer(ent({ outils: [{ famille: "messagerie", outil: "microsoft_365" }] }));
    const a = r.impossibles.find((x) => x.code === "AUT-102");
    expect(a?.raison).toEqual({ code: "famille_sans_outil", famille: "crm" });
    // « crm » est sans outil et « messagerie » est couverte ; une famille à créer ne passe jamais avant.
    const r2 = calculer(ent({ outils: [{ famille: "messagerie", outil: "autre_messagerie" }] }));
    expect(codes(r2.impossibles)).toContain("AUT-102");
    expect(codes(r2.a_creer)).not.toContain("AUT-102");
  });

  it("[A-410] un outil sans connecteur au catalogue rend « à créer » avec la famille et l'outil en raison", () => {
    // connecteur_disponible = true est ignoré : seul le catalogue des connecteurs fait foi.
    const r = calculer(ent({ outils: [{ famille: "messagerie", outil: "boite_maison", connecteur_disponible: true } as never] }));
    expect(r.a_creer.find((x) => x.code === "AUT-103")?.raison).toEqual({ code: "connecteur_absent", famille: "messagerie", outil: "boite_maison" });
  });

  it("[A-410] la sortie est triée par code et les entrées gelées ne sont pas modifiées", () => {
    const e = geler(ent({ outils: [{ famille: "messagerie", outil: "microsoft_365" }, { famille: "agenda", outil: "microsoft_365" }] }));
    const r = calculer(e);
    expect(codes(r.compatibles)).toEqual(["AUT-101", "AUT-103"]);
    expect(e.catalogue.map((a) => a.code)).toEqual(["AUT-102", "AUT-101", "AUT-103"]);
  });

  it("[A-410] les raisons sont des codes fermés, jamais un texte venu du catalogue", () => {
    const piege = [{ code: "AUT-104", nom: "<script>alert(1)</script>", familles: ["telephonie"] }];
    const r = calculer(ent({ catalogue: piege }));
    expect(r.impossibles[0]?.raison).toEqual({ code: "famille_sans_outil", famille: "telephonie" });
    expect(JSON.stringify(r.impossibles[0]?.raison)).not.toContain("script");
    expect(["famille_sans_outil", "connecteur_absent", "familles_couvertes", "aucune_connexion"]).toContain(calculer(ent()).compatibles.concat(calculer(ent()).impossibles)[0]?.raison.code);
  });

  it("[A-408] chaque automatisation porte sa fiche de connexion : familles demandées et outils compatibles du catalogue", () => {
    const r = calculer(ent({ outils: [{ famille: "messagerie", outil: "boite_maison" }, { famille: "agenda", outil: "microsoft_365" }] }));
    const a = [...r.compatibles, ...r.a_creer, ...r.impossibles].find((x) => x.code === "AUT-102");
    expect(a?.fiche).toEqual([{ famille: "crm", outils_compatibles: [] }, { famille: "messagerie", outils_compatibles: ["microsoft_365"] }]);
    const sans = calculer(ent({ catalogue: [{ code: "AUT-105", nom: "Sans connexion", familles: [] }] }));
    expect(sans.compatibles[0]).toMatchObject({ code: "AUT-105", raison: { code: "aucune_connexion" }, fiche: [] });
  });

  it("[C-200] la gamme conseillée est rendue par automatisation, null si le catalogue ne la donne pas", () => {
    const r = calculer(ent({ outils: [{ famille: "agenda", outil: "microsoft_365" }], gammes: { "AUT-101": "avance" } }));
    expect(r.compatibles.find((x) => x.code === "AUT-101")?.gamme_conseillee).toBe("avance");
    expect([...r.compatibles, ...r.a_creer, ...r.impossibles].find((x) => x.code === "AUT-103")?.gamme_conseillee).toBeNull();
  });
});
