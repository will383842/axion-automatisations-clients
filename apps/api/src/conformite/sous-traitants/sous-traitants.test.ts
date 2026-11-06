import { describe, expect, it } from "vitest";
import { LISTE_SOUS_TRAITANTS, listeCentreConformite, listeContrat, listeMesDocuments } from "./liste.js";
import { annoncer, ajouterJours, enVigueur, exigerEnVigueur, journalAnnoncesEnMemoire, reporterDateEffet } from "./preavis.js";

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C3 = "33333333-3333-4333-8333-333333333333";
const NOUVEAU = { id: "st-9", nom: "Fournisseur Test", service: "IA de secours", role: "fournisseur d'IA", lieu: "UE", accord: "a_signer" as const };

function monde(actifs: string[], jour = "2026-11-06") {
  const journal = journalAnnoncesEnMemoire();
  const envoyes: { clientId: string; cle: string }[] = [];
  const deps = {
    journal,
    aujourdhui: () => jour,
    clientsActifs: async () => actifs,
    envoyer: async (m: { clientId: string; cle: string }) => void envoyes.push(m),
  };
  return { deps, journal, envoyes, actifs };
}

describe("sous-traitants ultérieurs et préavis", () => {
  it("[C-032] un sous-traitant ajouté n'est en vigueur qu'à J+30 de l'annonce", async () => {
    const { deps } = monde([C1]);
    const a = await annoncer(deps, NOUVEAU);
    expect(a.dateEffet).toBe(ajouterJours("2026-11-06", 30));
    expect(a.dateEffet).toBe("2026-12-06");
    expect(enVigueur(a, "2026-12-05")).toBe(false);
    expect(enVigueur(a, "2026-12-06")).toBe(true);
    // Le produit ne s'en sert pas avant (interrupteur du fournisseur fermé).
    expect(() => exigerEnVigueur(a, "2026-11-20")).toThrow(/préavis/);
    expect(() => exigerEnVigueur(a, "2026-12-06")).not.toThrow();
  });

  it("[C-032] une annonce antidatée ne raccourcit pas le préavis : la date d'effet est la date d'envoi réelle + 30 jours", async () => {
    const { deps, journal } = monde([C1], "2026-11-06");
    // @ts-expect-error la date n'est plus un paramètre : l'appelant ne peut pas l'imposer
    const a = await annoncer(deps, NOUVEAU, "2026-10-01");
    expect(a.annonceLe).toBe("2026-11-06");
    expect(a.dateEffet).toBe("2026-12-06");
    expect(enVigueur(a, "2026-11-06")).toBe(false);
    expect(() => journal.enregistrer({ ...a, id: "annonce-forgee", dateEffet: "2026-10-31" })).toThrow(/30 jours/);
  });

  it("[C-032] la date d'effet ne peut pas être raccourcie après l'annonce", async () => {
    const { deps } = monde([C1]);
    const a = await annoncer(deps, NOUVEAU);
    expect(() => reporterDateEffet(a, "2026-11-10")).toThrow(/30 jours/);
    expect(reporterDateEffet(a, "2026-12-20").dateEffet).toBe("2026-12-20");
    expect(() => reporterDateEffet(reporterDateEffet(a, "2026-12-20"), "2026-12-06")).toThrow();
  });

  it("[C-032] l'annonce part à chaque client actif par la notification de service, une seule fois", async () => {
    const { deps, envoyes } = monde([C1, C2]);
    const a = await annoncer(deps, NOUVEAU);
    expect(envoyes.map((e) => e.clientId).sort()).toEqual([C1, C2]);
    await annoncer(deps, NOUVEAU);
    expect(envoyes).toHaveLength(2);
    expect(new Set(envoyes.map((e) => e.cle)).size).toBe(2);
    expect(envoyes.every((e) => e.cle.includes(a.id))).toBe(true);
  });

  it("[C-032] un client entré pendant le préavis reçoit l'annonce au rattrapage, sans doublon pour les autres", async () => {
    const m = monde([C1]);
    await annoncer(m.deps, NOUVEAU);
    m.actifs.push(C3);
    await annoncer(m.deps, NOUVEAU);
    expect(m.envoyes.map((e) => e.clientId).sort()).toEqual([C1, C3]);
  });

  it("[C-032] la liste du centre de conformité et celle de « Mes documents » sont identiques", () => {
    expect(listeCentreConformite()).toEqual(listeMesDocuments());
    expect(listeCentreConformite()).toEqual(listeContrat());
    expect(listeCentreConformite().length).toBe(LISTE_SOUS_TRAITANTS.length);
  });

  it("[C-032] Stripe figure dans la liste avec le rôle « encaissement, aucune facture »", () => {
    const s = listeContrat().find((l) => l.nom === "Stripe");
    expect(s?.role).toMatch(/encaissement/);
    expect(s?.role).toMatch(/aucune facture/);
    expect(s?.accord).toBe("a_signer");
  });

  it("[C-032] un client entré après l'annonce trouve Stripe dans son contrat", () => {
    expect(listeContrat().map((l) => l.nom)).toContain("Stripe");
  });

  it("[A-112] Cloudflare figure dans la liste avec le rôle « relais chiffré, rien de stocké »", () => {
    const c = listeContrat().find((l) => l.nom === "Cloudflare");
    expect(c?.role).toBe("relais chiffré, rien de stocké");
  });
});
