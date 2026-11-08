import { describe, expect, it } from "vitest";
import { echapperLike, porteeDe, rechercher, SOURCES, type DepotRecherche, type LigneRecherche, type ParametresRecherche } from "./index.js";
import { creerDepotMemoire, type LigneMemoire } from "./memoire.js";

// Recherche globale de la console (T3-09a), dépôt en mémoire : mêmes règles que le SQL (portée et plateforme appliquées AVANT la limite).
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const PLATEFORME = "00000000-0000-0000-0000-000000000001";
const UUID_DEMANDE = "33333333-3333-4333-8333-333333333333";
const dirigeant = { role: "dirigeant", portee: { clients: [] as string[], automatisations: [] as string[] } };
const secondA = { role: "second_administrateur", portee: { clients: [A], automatisations: [] as string[] } };

const client = (id: string, libelle: string, extra: Partial<LigneMemoire> = {}): LigneMemoire => ({ type: "client", id, client_id: id, libelle, statut: "client", ...extra }) as LigneMemoire;
const contact = (n: string, clientId: string, libelle: string, email: string): LigneMemoire => ({ type: "contact", id: `c-${n}`, client_id: clientId, client_nom: "Atelier Bertin", libelle, email, role: "principal" });
const jeu = (): LigneMemoire[] => [
  client(A, "Atelier Bertin", { siren: "123456782" }),
  client(B, "Boulangerie Rivoire"),
  contact("1", A, "Claire Bertin", "claire@exemple.fr"),
  { type: "facture", id: "f-1", client_id: A, client_nom: "Atelier Bertin", libelle: "AXI-FACT-0001", statut: "emise", periode_debut: "2026-02-01", periode_fin: "2026-02-28" },
  { type: "demande", id: UUID_DEMANDE, client_id: A, client_nom: "Atelier Bertin", libelle: "question", statut: "nouvelle", cree_le: "2026-11-01T08:00:00Z" },
  { type: "instance", id: "i-1", client_id: A, client_nom: "Atelier Bertin", libelle: "relance-devis", automatisation_nom: "Relance des devis", etat: "active" },
];

describe("recherche globale (service)", () => {
  it("[B-074] la recherche trouve clients, contacts, factures, demandes et instances, groupés dans cet ordre", async () => {
    const depot = creerDepotMemoire([...jeu(), client("44444444-4444-4444-8444-444444444444", "Bertin Frères")]);
    expect(SOURCES).toEqual(["client", "contact", "facture", "demande", "instance"]);
    const trouves = await rechercher(depot, dirigeant, "bertin", 5);
    expect(trouves.groupes.map((g) => g.type)).toEqual(["client", "contact", "facture", "demande", "instance"]);
    // égalité exacte d'abord, puis début du libellé, puis libellé : « Atelier Bertin » et « Bertin Frères » contiennent tous deux le terme ; « Bertin Frères » commence par lui.
    expect(trouves.groupes[0]?.resultats.map((r) => r.libelle)).toEqual(["Bertin Frères", "Atelier Bertin"]);
    const facture = await rechercher(depot, dirigeant, "axi-fact", 5);
    expect(facture.groupes[2]?.resultats).toHaveLength(1);
    expect((await rechercher(depot, dirigeant, "QUESTION", 5)).groupes[3]?.resultats).toHaveLength(1);
    expect((await rechercher(depot, dirigeant, "relance", 5)).groupes[4]?.resultats).toHaveLength(1);
  });

  it("[B-099] une recherche par l'e-mail d'un contact rend le client à ouvrir", async () => {
    const depot = creerDepotMemoire(jeu());
    const parMail = await rechercher(depot, dirigeant, "claire@exemple.fr", 5);
    expect(parMail.groupes[1]?.resultats).toMatchObject([{ type: "contact", client_id: A, email: "claire@exemple.fr" }]);
    const parNom = await rechercher(depot, dirigeant, "Claire", 5);
    expect(parNom.groupes[1]?.resultats).toMatchObject([{ client_id: A }]);
  });

  it("[B-126] @isolation la recherche ne rend rien hors de la portée du membre", async () => {
    const depot = creerDepotMemoire([...jeu(), contact("b", B, "Bruno Rivoire", "bruno@exemple.fr"), { type: "facture", id: "f-b", client_id: B, client_nom: "Boulangerie Rivoire", libelle: "AXI-FACT-0002", statut: "emise", periode_debut: "2026-02-01", periode_fin: "2026-02-28" }]);
    const json = JSON.stringify(await Promise.all(["rivoire", "bruno", "axi-fact", "boulangerie", "exemple"].map((q) => rechercher(depot, secondA, q, 20))));
    for (const trace of [B, "Rivoire", "bruno", "AXI-FACT-0002"]) expect(json).not.toContain(trace);
    expect(json).toContain("AXI-FACT-0001");
  });

  it("[LOT3-recherche] la portée filtre avant la limite : dix résultats hors portée ne cachent pas le résultat permis", async () => {
    const hors = Array.from({ length: 10 }, (_, i) => contact(`b${i}`, B, `Dupont Aa${i}`, `d${i}@exemple.fr`));
    const depot = creerDepotMemoire([...hors, contact("a", A, "Dupont Zz", "z@exemple.fr")]);
    const r = await rechercher(depot, secondA, "dupont", 5);
    expect(r.groupes[1]?.resultats).toMatchObject([{ id: "c-a", client_id: A }]);
  });

  it("[LOT3-recherche] une portée trouves ne lit rien et rend cinq groupes vides", async () => {
    let appels = 0;
    const espion: DepotRecherche = { chercher: async () => { appels++; return []; } };
    for (const membre of [{ role: "second_administrateur", portee: { clients: [], automatisations: [] } }, { role: "inconnu", portee: { clients: [A], automatisations: [] } }]) {
      const r = await rechercher(espion, membre, "bertin", 5);
      expect(r.groupes.map((g) => [g.type, g.resultats.length])).toEqual(SOURCES.map((s) => [s, 0]));
    }
    expect(appels).toBe(0);
  });

  it("[LOT3-recherche] la portée vient du membre : « * » vaut tous les clients, un élément non UUID est écarté", () => {
    expect(porteeDe(dirigeant)).toEqual({ tous: true, clients: [] });
    expect(porteeDe({ role: "second_administrateur", portee: { clients: ["*"], automatisations: [] } })).toEqual({ tous: true, clients: [] });
    expect(porteeDe({ role: "second_administrateur", portee: { clients: [A, A, "pas-un-uuid", "' OR 1=1 --", B.toUpperCase()], automatisations: [] } })).toEqual({ tous: false, clients: [A, B] });
    expect(porteeDe({ role: "second_administrateur", portee: { clients: [], automatisations: [] } })).toEqual({ tous: false, clients: [] });
    expect(porteeDe({ role: "inconnu", portee: { clients: ["*", A], automatisations: [] } })).toEqual({ tous: false, clients: [] });
  });

  it("[LOT3-recherche] une ligne hors portée rendue par erreur par le dépôt est écartée", async () => {
    const menteur: DepotRecherche = { chercher: async () => jeu().map((l) => ({ ...l, client_id: B }) as LigneRecherche).concat(jeu().filter((l) => l.client_id === A)) };
    const r = await rechercher(menteur, secondA, "bertin", 20);
    expect(JSON.stringify(r)).not.toContain(B);
    expect(r.groupes.flatMap((g) => g.resultats).length).toBeGreaterThan(0);
  });

  it("[LOT3-recherche] la réponse est en liste blanche : un champ en trop du dépôt ne sort pas", async () => {
    const trop: DepotRecherche = { chercher: async () => [{ ...jeu()[3], montant_ht_centimes: 1, reference_texte: "demande:x" } as never] };
    const r = await rechercher(trop, dirigeant, "axi", 5);
    expect(JSON.stringify(r)).not.toMatch(/montant|reference_texte|demande:/);
  });

  it("[LOT3-recherche] echapperLike neutralise le pourcent, le souligné et la barre oblique inverse", () => {
    expect(echapperLike("50%")).toBe("50\\%");
    expect(echapperLike("a_b")).toBe("a\\_b");
    expect(echapperLike("a\\b")).toBe("a\\\\b");
    expect(echapperLike("\\%_")).toBe("\\\\\\%\\_");
    expect(echapperLike("simple")).toBe("simple");
  });

  it("[LOT3-recherche] le terme n'est comparé à un identifiant de demande que s'il a la forme d'un UUID", async () => {
    const vus: ParametresRecherche[] = [];
    const espion: DepotRecherche = { chercher: async (p) => { vus.push(p); return []; } };
    await rechercher(espion, dirigeant, UUID_DEMANDE.toUpperCase(), 5);
    await rechercher(espion, dirigeant, "33333333-3333", 5);
    await rechercher(espion, dirigeant, "123456782", 5);
    await rechercher(espion, dirigeant, "'; select 1", 5);
    expect(vus.map((p) => p.idDemande)).toEqual([UUID_DEMANDE, null, null, null]);
    expect(vus.map((p) => p.siren)).toEqual([null, null, "123456782", null]);
    expect(vus[3]?.motif).toBe("%'; select 1%");
    expect(vus[0]).toMatchObject({ tous: true, clients: [], limite: 5 });
  });

  it("[LOT3-recherche] la plateforme n'est jamais un résultat et le dépôt reçoit sa portée", async () => {
    const depot = creerDepotMemoire([client(PLATEFORME, "Valeurs de la plateforme"), contact("p", PLATEFORME, "Plateforme Contact", "p@exemple.fr"), ...jeu()]);
    const r = await rechercher(depot, dirigeant, "plateforme", 20);
    expect(r.groupes.flatMap((g) => g.resultats)).toEqual([]);
  });
});
