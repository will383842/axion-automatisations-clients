import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { fastifyVide } from "../../../../../scripts/liste-routes.js";
import { depotSqlListe, routeListeCatalogue, type DepsListeCatalogue, type LigneCatalogue, type ServiceListe } from "./liste.js";

// Liste minimale du catalogue (T3-31a2) : filtre par métier et pagination par code. Aucun prix, aucun tri ni autre filtre (T3-40).
const LIGNES: LigneCatalogue[] = ["AUT-001", "AUT-002", "AUT-003", "AUT-004", "AUT-005"].map((code, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i + 1}`, code, nom: `Automatisation ${i + 1}`, statut: "publiee", visibilite: "catalogue",
  metiers: i % 2 === 0 ? ["btp_artisans"] : ["cabinets_comptables"],
}));
const METIERS = ["btp_artisans", "cabinets_comptables"];
const MEMBRE = { sujet: "m1", role: "dirigeant" as const, actif: true, portee: { clients: [], automatisations: [] } };

function monter(ouvert = true) {
  const appels: { methode: string; arg: unknown }[] = [];
  // Faux service qui rejoue la sémantique du SQL : OU entre métiers, code > curseur, limite + 1 lignes.
  const service: ServiceListe = {
    metiersConnus: async (codes) => { appels.push({ methode: "metiersConnus", arg: codes }); return codes.filter((c) => METIERS.includes(c)); },
    lister: async (d) => {
      appels.push({ methode: "lister", arg: d });
      return LIGNES.filter((l) => (d.metiers === null || l.metiers.some((m) => d.metiers?.includes(m))) && (d.curseur === null || l.code > d.curseur)).slice(0, d.limite + 1);
    },
  };
  const deps: DepsListeCatalogue = {
    ouvert, exigerEquipe: async () => undefined, service,
    droits: { membre: async () => MEMBRE, absenceOuverte: async () => false, tracer: async () => undefined },
  };
  const appli = fastifyVide();
  brancherErreurs(appli);
  routeListeCatalogue(appli, deps);
  return { appli, appels };
}
const lister = (appli: ReturnType<typeof monter>["appli"], requete = "") => appli.inject({ method: "GET", url: `/api/console/v1/catalogue${requete}` });

describe("liste du catalogue", () => {
  it("[B-342] le catalogue se filtre par métier", async () => {
    const { appli } = monter();
    const r = await lister(appli, "?metier=btp_artisans");
    expect(r.statusCode).toBe(200);
    expect(r.json().automatisations.map((a: LigneCatalogue) => a.code)).toEqual(["AUT-001", "AUT-003", "AUT-005"]);
  });

  it("[B-342] deux métiers rendent l'union des deux", async () => {
    const { appli, appels } = monter();
    const r = await lister(appli, "?metier=btp_artisans&metier=cabinets_comptables");
    expect(r.json().automatisations).toHaveLength(5);
    expect(appels.find((a) => a.methode === "lister")?.arg).toMatchObject({ metiers: ["btp_artisans", "cabinets_comptables"] });
  });

  it("[B-342] un métier inconnu rend 422, 21 métiers ou une limite de 101 rendent 400", async () => {
    const { appli, appels } = monter();
    const inconnu = await lister(appli, "?metier=metier_absent");
    expect(inconnu.statusCode).toBe(422);
    expect(inconnu.json().erreur).toMatchObject({ code: "regle_metier", message: "Métier inconnu." });
    expect(appels.some((a) => a.methode === "lister")).toBe(false);
    const avant = appels.length;
    const vingtEtUn = Array.from({ length: 21 }, (_, i) => `metier_${i + 10}`).map((m) => `metier=${m}`).join("&");
    expect((await lister(appli, `?${vingtEtUn}`)).statusCode).toBe(400);
    expect((await lister(appli, "?limite=101")).statusCode).toBe(400);
    expect((await lister(appli, "?limite=0")).statusCode).toBe(400);
    expect((await lister(appli, "?metier=Mauvais-Format")).statusCode).toBe(400);
    expect((await lister(appli, "?tri=nom")).statusCode).toBe(400);
    expect(appels.length).toBe(avant);
  });

  it("[B-342] la pagination par code est stable et suivant vaut null à la fin", async () => {
    const { appli } = monter();
    const vus: string[] = [];
    let curseur: string | null = null;
    for (let tour = 0; tour < 5; tour++) {
      const r = await lister(appli, `?limite=2${curseur ? `&curseur=${curseur}` : ""}`);
      const corps = r.json() as { automatisations: LigneCatalogue[]; suivant: string | null };
      vus.push(...corps.automatisations.map((a) => a.code));
      if (corps.suivant === null) break;
      expect(corps.suivant).toBe(corps.automatisations.at(-1)?.code);
      curseur = corps.suivant;
    }
    expect(vus).toEqual(LIGNES.map((l) => l.code));
    expect(curseur).toBe("AUT-004");
  });

  it("[B-342] la liste ne contient aucun prix", async () => {
    const { appli } = monter();
    const corps = (await lister(appli)).json();
    expect(Object.keys(corps).sort()).toEqual(["automatisations", "suivant"]);
    expect(Object.keys(corps.automatisations[0]).sort()).toEqual(["code", "id", "metiers", "nom", "statut", "visibilite"]);
  });

  it("[B-342] un curseur hors motif rend 400 sans appel", async () => {
    const { appli, appels } = monter();
    for (const c of ["x", "AUT-1", "aut-001", "AUT-001'; DROP TABLE automatisations;--", "AUT-001%20"]) expect((await lister(appli, `?curseur=${encodeURIComponent(c)}`)).statusCode, c).toBe(400);
    expect(appels).toEqual([]);
  });

  it("[B-342] la porte fermée rend 503 sans appel, même sans session", async () => {
    const { appli, appels } = monter(false);
    const r = await lister(appli);
    expect(r.statusCode).toBe(503);
    expect(appels).toEqual([]);
  });

  it("[B-342] le dépôt SQL passe les valeurs en paramètres, sans concaténation", async () => {
    const requetes: { texte: string; valeurs: unknown[] }[] = [];
    const depot = depotSqlListe(async (texte, valeurs) => { requetes.push({ texte, valeurs }); return { rows: [] }; });
    await depot.lister({ metiers: ["btp_artisans"], curseur: "AUT-002", limite: 50 });
    const { texte, valeurs } = requetes[0] ?? { texte: "", valeurs: [] };
    expect(valeurs).toEqual([["btp_artisans"], "AUT-002", 50]);
    expect(texte).toContain("ORDER BY a.code");
    expect(texte).toContain("LIMIT $3 + 1");
    expect(texte).not.toMatch(/btp_artisans|AUT-002/);
    expect(texte).not.toMatch(/grilles_prix|centimes|prix/i);
  });
});
