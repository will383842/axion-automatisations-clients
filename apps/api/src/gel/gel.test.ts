import { describe, expect, it } from "vitest";
import { envoisServiceEnMemoire } from "../envois/service.js";
import { ENVOIS_COMMERCIAUX } from "../envois/exclusions.js";
import { depotGelsEnMemoire, gelActif, leverGel, poserGel, type DepsGel, type SessionEquipe } from "./gel.js";

// Gel pour litige (C-609) : dépôt en mémoire derrière le port DepotGels (la table gels_litige existe, l'adaptateur SQL est une dette).
const CLIENT = "11111111-1111-4111-8111-111111111111";
const AUTRE = "33333333-3333-4333-8333-333333333333";
const MAINTENANT = new Date("2026-11-02T10:00:00Z");
const admin: SessionEquipe = { acteur: "will383842", role: "administrateur", clientActifId: CLIENT, reauthentifie: true };
function monde() {
  const depot = depotGelsEnMemoire();
  const envois = envoisServiceEnMemoire();
  let n = 0;
  const deps: DepsGel = { depot, envois, maintenant: () => MAINTENANT, nouvelId: () => `gel-${++n}` };
  return { depot, envois, deps };
}

describe("gel pour litige : pose et levée", () => {
  it("[C-609] Will pose un gel daté avec un motif ; il est tracé", async () => {
    const { deps, depot } = monde();
    const g = await poserGel(deps, admin, CLIENT, "  litige de facturation  ");
    expect(g).toMatchObject({ tenantId: CLIENT, motif: "litige de facturation", poseePar: "will383842", leveeLe: null, levePar: null });
    expect(g.poseeLe).toEqual(MAINTENANT);
    expect(await depot.lister(CLIENT)).toHaveLength(1);
    expect(await gelActif(depot, CLIENT)).toBe(true);
    expect(await gelActif(depot, AUTRE)).toBe(false);
  });

  it("[C-609] motif vide, date de pose future et acteur de repli « systeme » sont refusés", async () => {
    const { deps, depot } = monde();
    for (const m of ["", "   "]) await expect(poserGel(deps, admin, CLIENT, m)).rejects.toMatchObject({ code: "schema_invalide" });
    await expect(poserGel(deps, admin, CLIENT, "motif", new Date(MAINTENANT.getTime() + 1))).rejects.toMatchObject({ code: "schema_invalide" });
    await expect(poserGel(deps, admin, CLIENT, "motif", new Date("pas une date"))).rejects.toMatchObject({ code: "schema_invalide" });
    for (const a of ["systeme", "Systeme", " "]) await expect(poserGel(deps, { ...admin, acteur: a }, CLIENT, "motif")).rejects.toMatchObject({ code: "action_interdite" });
    await expect(poserGel(deps, admin, CLIENT, "motif", new Date("2026-10-01T00:00:00Z"))).resolves.toBeDefined();
    expect(await depot.lister(CLIENT)).toHaveLength(1);
  });

  it("[C-609] la pose et la levée exigent la réauthentification et le rôle administrateur", async () => {
    const { deps, depot } = monde();
    await expect(poserGel(deps, { ...admin, reauthentifie: false }, CLIENT, "m")).rejects.toMatchObject({ code: "reauthentification_requise" });
    await expect(poserGel(deps, { ...admin, role: "support" }, CLIENT, "m")).rejects.toMatchObject({ code: "action_interdite" });
    expect(await depot.lister(CLIENT)).toEqual([]);
    const g = await poserGel(deps, admin, CLIENT, "m");
    await expect(leverGel(deps, { ...admin, reauthentifie: false }, CLIENT, g.id, "fin")).rejects.toMatchObject({ code: "reauthentification_requise" });
    await expect(leverGel(deps, { ...admin, role: "support" }, CLIENT, g.id, "fin")).rejects.toMatchObject({ code: "action_interdite" });
    expect(await gelActif(depot, CLIENT)).toBe(true);
  });

  it("[C-609] le client de l'URL doit être l'organisation de la session, pour la pose comme pour la levée", async () => {
    const { deps, depot } = monde();
    await expect(poserGel(deps, admin, AUTRE, "m")).rejects.toMatchObject({ code: "action_interdite" });
    expect(await depot.lister(AUTRE)).toEqual([]);
    const g = await poserGel(deps, admin, CLIENT, "m");
    await expect(leverGel(deps, { ...admin, clientActifId: AUTRE }, AUTRE, g.id, "fin")).rejects.toMatchObject({ code: "introuvable" });
    await expect(leverGel(deps, admin, AUTRE, g.id, "fin")).rejects.toMatchObject({ code: "action_interdite" });
    expect(await gelActif(depot, CLIENT)).toBe(true);
  });

  it("[C-609] la levée se fait d'un clic, garde l'historique et rouvre les retraits", async () => {
    const { deps, depot } = monde();
    const g = await poserGel(deps, admin, CLIENT, "premier litige");
    const leve = await leverGel(deps, admin, CLIENT, g.id, "litige réglé");
    expect(leve).toMatchObject({ id: g.id, motif: "premier litige", poseePar: "will383842", levePar: "will383842" });
    expect(leve.leveeLe).toEqual(MAINTENANT);
    expect(await gelActif(depot, CLIENT)).toBe(false);
    await expect(leverGel(deps, { ...admin, acteur: "autre.admin" }, CLIENT, g.id, "encore")).rejects.toMatchObject({ code: "regle_metier" });
    // Reposé : l'historique garde les deux lignes, la première reste levée.
    await poserGel(deps, admin, CLIENT, "second litige");
    const histoire = await depot.lister(CLIENT);
    expect(histoire.map((x) => [x.motif, x.leveeLe !== null])).toEqual([["premier litige", true], ["second litige", false]]);
    expect(await gelActif(depot, CLIENT)).toBe(true);
  });

  it("[C-609] le dépôt n'a aucune méthode de suppression et un gel inconnu ou d'un autre client est introuvable", async () => {
    const { deps, depot } = monde();
    expect(Object.keys(depot).filter((k) => /suppr|supprimer|delete|effacer|retirer/i.test(k))).toEqual([]);
    await expect(leverGel(deps, admin, CLIENT, "inconnu", "m")).rejects.toMatchObject({ code: "introuvable" });
    await expect(leverGel(deps, admin, CLIENT, "gel-1", "")).rejects.toMatchObject({ code: "schema_invalide" });
  });

  it("[C-609] deux poses identiques de la même personne ne font qu'un gel actif ; une autre personne est refusée", async () => {
    const { deps, depot } = monde();
    const g = await poserGel(deps, admin, CLIENT, "même motif");
    await expect(poserGel(deps, { ...admin, acteur: "autre.admin" }, CLIENT, " même motif ")).rejects.toMatchObject({ code: "regle_metier" });
    expect(await poserGel(deps, admin, CLIENT, " même motif ")).toMatchObject({ id: g.id });
    expect(await depot.lister(CLIENT)).toHaveLength(1);
  });

  it("[C-609] la date de pose ne remonte pas au-delà d'une limite raisonnable", async () => {
    const { deps, depot } = monde();
    await expect(poserGel(deps, admin, CLIENT, "m", new Date("2020-01-01T00:00:00Z"))).rejects.toMatchObject({ code: "schema_invalide" });
    expect(await depot.lister(CLIENT)).toEqual([]);
  });

  it("[C-609] l'avis perdu à la pose est redéposé par une nouvelle tentative, sans doublon ni second gel", async () => {
    const { deps, depot, envois } = monde();
    let echec = true;
    const instable = { deposerService: async (m: Parameters<typeof envois.deposerService>[0]) => { if (echec) { echec = false; throw new Error("panne"); } await envois.deposerService(m); } };
    const d2: DepsGel = { ...deps, envois: instable };
    await expect(poserGel(d2, admin, CLIENT, "litige")).rejects.toThrow("panne");
    expect(envois.deposes).toHaveLength(0);
    const g = await poserGel(d2, admin, CLIENT, "litige");
    expect(await depot.lister(CLIENT)).toHaveLength(1);
    expect(envois.deposes.map((m) => m.cle)).toEqual([`avis_gel_pose:${CLIENT}:${g.id}`]);
    await poserGel(d2, admin, CLIENT, "litige");
    expect(envois.deposes).toHaveLength(1);
  });

  it("[C-609] l'avis perdu à la levée est redéposé par la même personne ; une autre personne est refusée", async () => {
    const { deps, envois } = monde();
    const g = await poserGel(deps, admin, CLIENT, "litige");
    let echec = true;
    const instable = { deposerService: async (m: Parameters<typeof envois.deposerService>[0]) => { if (echec) { echec = false; throw new Error("panne"); } await envois.deposerService(m); } };
    const d2: DepsGel = { ...deps, envois: instable };
    await expect(leverGel(d2, admin, CLIENT, g.id, "fin")).rejects.toThrow("panne");
    await expect(leverGel(d2, { ...admin, acteur: "autre.admin" }, CLIENT, g.id, "fin")).rejects.toMatchObject({ code: "regle_metier" });
    expect(await leverGel(d2, admin, CLIENT, g.id, "fin")).toMatchObject({ id: g.id, levePar: "will383842" });
    await leverGel(d2, admin, CLIENT, g.id, "fin");
    expect(envois.deposes.map((m) => m.type)).toEqual(["avis_gel_pose", "avis_gel_leve"]);
  });

  it("[C-609] le client est informé à la pose et à la levée par un e-mail de service dont le type n'est dans aucune liste commerciale", async () => {
    const { deps, envois } = monde();
    const g = await poserGel(deps, admin, CLIENT, "m");
    await leverGel(deps, admin, CLIENT, g.id, "fin");
    expect(envois.deposes.map((m) => [m.type, m.clientId, m.categorie])).toEqual([["avis_gel_pose", CLIENT, "service"], ["avis_gel_leve", CLIENT, "service"]]);
    expect(envois.deposes[0]!.cle).toBe(`avis_gel_pose:${CLIENT}:${g.id}`);
    expect(new Set(envois.deposes.map((m) => m.cle)).size).toBe(2);
    // Test de liste seulement : la preuve par une vraie exclusion est la dette LOT2-dette-T2-43-branchement (transport réel).
    for (const m of envois.deposes) expect(ENVOIS_COMMERCIAUX as readonly string[]).not.toContain(m.type);
    await expect(envois.deposerService({ type: "newsletter" as never, clientId: CLIENT, cle: "x", categorie: "service" })).rejects.toThrow();
  });

  it("[C-609] le texte de l'avis ne porte ni le motif ni aucun nom en dur : seuls le type, le client et la clé sortent", async () => {
    const { deps, envois } = monde();
    await poserGel(deps, admin, CLIENT, "motif confidentiel");
    expect(JSON.stringify(envois.deposes)).not.toContain("confidentiel");
    expect(Object.keys(envois.deposes[0]!).sort()).toEqual(["categorie", "cle", "clientId", "type"]);
  });
});
