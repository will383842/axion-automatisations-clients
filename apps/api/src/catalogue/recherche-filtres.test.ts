import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyserFiltres, comparer, decoderCurseur, encoderCurseur, type LigneCatalogue } from "./filtres.js";
import { normaliser, creerServiceCatalogue, type DepotCatalogue } from "./recherche.js";
import { proches } from "./doublons.js";

// Catalogue à grande échelle (T3-40a) : automatisations FICTIVES, faux dépôt en mémoire. Aucune lecture d'une base de client.
const ligne = (i: number, extra: Partial<LigneCatalogue> = {}): LigneCatalogue => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  code: `auto-${i}`,
  nom: `Automatisation ${String(i).padStart(3, "0")}`,
  metiers: ["rh"],
  postes: ["assistant"],
  outils: ["outil-a"],
  statut_automatisation: "au_catalogue",
  nb_clients: i % 7,
  minutes_gagnees: i % 5 === 0 ? null : i,
  derniere_version_le: "2026-11-01T10:00:00.000Z",
  ...extra,
});

// Faux dépôt : applique le MÊME ordre (comparer) et le curseur ; enregistre ce qu'il reçoit.
function faux(lignes: LigneCatalogue[], synonymes: { mot: string; equivalent: string }[] = []) {
  const recu: { termes?: string[]; motifs?: string[]; filtres?: ReturnType<typeof analyserFiltres> } = {};
  const depot: DepotCatalogue = {
    async lister(f, taille) {
      recu.filtres = f;
      const tries = [...lignes].sort((a, b) => comparer(a, b, f.tri, f.ordre));
      const c = f.curseur;
      const apres = c ? tries.filter((l) => comparer(l, { ...l, id: c.id, nom: String(c.v ?? ""), nb_clients: Number(c.v ?? 0), minutes_gagnees: c.v === null ? null : Number(c.v), derniere_version_le: c.v === null ? null : String(c.v) }, f.tri, f.ordre) > 0) : tries;
      return apres.slice(0, taille);
    },
    async chercher(termes, motifs) { recu.termes = termes; recu.motifs = motifs; return lignes.slice(0, 3); },
    async synonymes() { return synonymes; },
    async ajouterSynonyme() { return; },
    async candidats() { return lignes; },
  };
  return { depot, recu, service: creerServiceCatalogue(depot) };
}

describe("filtres du catalogue", () => {
  it("[B-532] plusieurs valeurs par filtre (OU), plusieurs filtres (ET), trois statuts distincts", () => {
    const f = analyserFiltres({ metier: "rh,compta", poste: "assistant", outil: "pennylane", statut_automatisation: "au_catalogue", statut_version: "publiee", statut_instance: "active", visibilite: "visible_clients" });
    expect(f.metier).toEqual(["rh", "compta"]);
    expect(f.statut_automatisation).toEqual(["au_catalogue"]);
    expect(f.statut_version).toEqual(["publiee"]);
    expect(f.statut_instance).toEqual(["active"]);
  });
  it("[B-532] un statut= nu est refusé, une valeur inconnue est refusée en 422", () => {
    expect(() => analyserFiltres({ statut: "au_catalogue" })).toThrowError(expect.objectContaining({ code: "schema_invalide" }) as Error);
    expect(() => analyserFiltres({ statut_automatisation: "publiee" })).toThrowError(expect.objectContaining({ code: "regle_metier" }) as Error);
    expect(() => analyserFiltres({ statut_version: "au_catalogue" })).toThrowError(expect.objectContaining({ code: "regle_metier" }) as Error);
    expect(() => analyserFiltres({ statut_instance: "publiee" })).toThrowError(expect.objectContaining({ code: "regle_metier" }) as Error);
  });
  it("[B-532] 500 valeurs de filtre ou une valeur piégée sont refusées", () => {
    const beaucoup = Array.from({ length: 500 }, (_, i) => `m${i}`).join(",");
    expect(() => analyserFiltres({ metier: beaucoup })).toThrowError(expect.objectContaining({ code: "schema_invalide" }) as Error);
    expect(() => analyserFiltres({ outil: "x'; DROP TABLE automatisations;--" })).toThrowError(expect.objectContaining({ code: "schema_invalide" }) as Error);
    expect(() => analyserFiltres({ poste: "%" })).toThrowError(expect.objectContaining({ code: "schema_invalide" }) as Error);
  });
  it("[B-532] le tri par temps gagné place les valeurs nulles en dernier, dans les deux sens", () => {
    const a = ligne(1, { minutes_gagnees: null });
    const b = ligne(2, { minutes_gagnees: 10 });
    const c = ligne(3, { minutes_gagnees: 20 });
    for (const ordre of ["asc", "desc"] as const) {
      const ids = [a, b, c].sort((x, y) => comparer(x, y, "temps_gagne", ordre)).map((l) => l.id);
      expect(ids[2]).toBe(a.id);
    }
  });
  it("[B-532] un curseur altéré, d'un autre tri ou trop long est refusé", () => {
    const bon = encoderCurseur({ tri: "nom", ordre: "asc", v: "Automatisation 001", id: ligne(1).id });
    expect(decoderCurseur(bon, "nom", "asc")?.id).toBe(ligne(1).id);
    expect(() => decoderCurseur(bon, "clients", "asc")).toThrowError(expect.objectContaining({ code: "schema_invalide" }) as Error);
    expect(() => decoderCurseur("pas-un-curseur", "nom", "asc")).toThrowError(expect.objectContaining({ code: "schema_invalide" }) as Error);
    expect(() => analyserFiltres({ curseur: "a".repeat(2000) })).toThrowError(expect.objectContaining({ code: "schema_invalide" }) as Error);
  });
});

describe("liste paginée", () => {
  it("[C-686] pagination : 60 automatisations fictives, curseur stable, tri et filtres côté serveur", async () => {
    const lignes = Array.from({ length: 60 }, (_, i) => ligne(i + 1));
    for (const tri of ["nom", "clients", "temps_gagne"]) {
      const { service } = faux(lignes);
      const vus: string[] = [];
      let curseur: string | undefined;
      for (let page = 0; page < 10; page++) {
        const r = await service.lister({ tri, limite: "25", ...(curseur ? { curseur } : {}) });
        vus.push(...r.automatisations.map((l) => l.id));
        if (!r.curseur_suivant) break;
        curseur = r.curseur_suivant;
      }
      expect(vus).toHaveLength(60);
      expect(new Set(vus).size).toBe(60);
    }
  });
  it("[B-532] le tri par nombre de clients et la pagination par curseur sont stables", async () => {
    const lignes = Array.from({ length: 30 }, (_, i) => ligne(i + 1, { nb_clients: 3 }));
    const { service } = faux(lignes);
    const p1 = await service.lister({ tri: "clients", limite: "10" });
    const p2 = await service.lister({ tri: "clients", limite: "10", curseur: p1.curseur_suivant ?? "" });
    expect(p1.automatisations.map((l) => l.id)).toEqual(lignes.slice(0, 10).map((l) => l.id));
    expect(p2.automatisations.map((l) => l.id)).toEqual(lignes.slice(10, 20).map((l) => l.id));
  });
  it("[B-532] métier RH + outil + statut au_catalogue : les filtres arrivent au dépôt tels quels", async () => {
    const { service, recu } = faux([ligne(1)]);
    await service.lister({ metier: "rh", outil: "pennylane", statut_automatisation: "au_catalogue" });
    expect(recu.filtres).toMatchObject({ metier: ["rh"], outil: ["pennylane"], statut_automatisation: ["au_catalogue"], poste: [] });
  });
  it("[B-532] deux postes cochés sont transmis comme une union", async () => {
    const { service, recu } = faux([ligne(1)]);
    await service.lister({ poste: "comptable,assistant" });
    expect(recu.filtres?.poste).toEqual(["comptable", "assistant"]);
  });
});

describe("recherche dans le catalogue", () => {
  it("[B-533] chercher « relance » ajoute le synonyme « rappel »", async () => {
    const { service, recu } = faux([ligne(1, { nom: "Rappel de facture" })], [{ mot: "relance", equivalent: "rappel" }]);
    const r = await service.rechercher({ q: "relance" });
    expect(recu.termes).toEqual(expect.arrayContaining(["relance", "rappel"]));
    expect(r.automatisations.length).toBeGreaterThan(0);
  });
  it("[B-533] « prereglage » sans accent et « PRÉRÉGLAGE » donnent le même terme", () => {
    expect(normaliser("prereglage")).toBe(normaliser("Préréglage"));
    expect(normaliser("PRÉRÉGLAGE")).toBe("prereglage");
  });
  it("[B-533] une recherche piégée est échappée ; 10 000 caractères sont refusés", async () => {
    const { service, recu } = faux([ligne(1)]);
    await service.rechercher({ q: "100%_\\" });
    expect(recu.motifs?.[0]).toBe("100\\%\\_\\\\");
    await expect(service.rechercher({ q: "a".repeat(10_000) })).rejects.toMatchObject({ code: "schema_invalide" });
    await expect(service.rechercher({ q: "a" })).rejects.toMatchObject({ code: "schema_invalide" });
  });
  it("[B-533] @isolation la recherche du catalogue ne lit aucune base client", () => {
    for (const f of ["recherche.ts", "filtres.ts", "doublons.ts"]) {
      const source = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/cli_|bases_client|connexionClient|schema\/clients/);
    }
  });
});

describe("signal de doublon", () => {
  const candidat = { nom: "Rappel de facture impayée", postes: ["comptable"], metiers: ["compta"], outils: ["pennylane"] };
  it("[B-534] une carte proche d'une automatisation existante montre le signal, sans empêcher de continuer", async () => {
    const existante = ligne(1, { nom: "Rappel de facture impayée", postes: ["comptable"], metiers: ["compta"], outils: ["pennylane"] });
    const lointaine = ligne(2, { nom: "Bilan de santé du site", postes: ["web"], metiers: ["marketing"], outils: ["outil-z"] });
    const { service } = faux([existante, lointaine]);
    const r = await service.doublons({ nom: candidat.nom, poste: "comptable", metier: "compta", outil: "pennylane" });
    expect(r.bloquant).toBe(false);
    expect(r.proches.map((p) => p.id)).toEqual([existante.id]);
    expect(proches(candidat, [lointaine])).toEqual([]);
  });
});
