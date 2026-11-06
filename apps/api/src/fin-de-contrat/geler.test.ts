import { describe, expect, it } from "vitest";
import { identifiantsPourTache, type PortsIdentifiants } from "../courtier/identifiants-base.js";
import { creerServiceDonnees } from "../donnees/service.js";
import type { LigneBase } from "../provisionnement/machine.js";
import { etapeGeler } from "./geler.js";
import type { Dossier } from "./machine.js";

const T = "11111111-1111-4111-8111-111111111111";
const ETAB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const D: Dossier = { dateFin: "2027-01-10", exportReference: null, exportTelechargeLe: null, preavis: { 1: { envoyeLe: null, accuse: null }, 20: { envoyeLe: null, accuse: null }, 27: { envoyeLe: null, accuse: null } } };

function monde(gel = false) {
  const base = { etat: "active" as LigneBase["etat"] };
  let actives = 2;
  const ordre: string[] = [];
  const etape = etapeGeler({
    etatBase: async () => base.etat,
    geler: async () => { ordre.push("gel"); base.etat = "gelee"; },
    pauserInstances: async () => { ordre.push("pause"); actives = 0; },
    instancesActives: async () => actives,
    emettreResilie: async (_t, dateFin) => void ordre.push(`resilie:${dateFin}`),
    gel: { gelActif: async () => gel },
  });
  return { base, etape, ordre };
}

describe("base gelée à la fin du contrat", () => {
  it("[A-254] à la fin du contrat, la base passe gelée : aucune écriture, aucun identifiant servi, instances en pause", async () => {
    const m = monde();
    expect(await m.etape.dejaFait(T, D)).toBe(false);
    await m.etape.faire(T, D);
    expect(await m.etape.dejaFait(T, D)).toBe(true);
    // C3 d'abord (si la tâche tombe ensuite, le rejeu l'émet encore), la bascule de la base en dernier.
    expect(m.ordre).toEqual(["resilie:2027-01-10", "pause", "gel"]);
    // Le service des données (T2-37) : ni écriture ni lecture, même pour l'équipe.
    const service = creerServiceDonnees({ base: async () => ({ nomBase: "cli_x", etat: m.base.etat }), ouvrir: async () => { throw new Error("jamais ouverte"); }, accordValide: async () => true, vueRangee: () => undefined, maintenant: () => new Date("2027-01-11T00:00:00Z") });
    for (const role of ["client", "equipe"] as const) {
      await expect(service.executer({ tenantId: T, role, acteur: "u1", etablissements: [ETAB] }, "compterPersonnes", {})).rejects.toMatchObject({ code: "introuvable" });
    }
    // Le courtier (T2-36) ne sert plus d'identifiants.
    const p = { proprietaireTache: async () => T, base: async () => ({ etat: m.base.etat, grappe: "g1" }), gelActif: async () => false, journal: { tracer: () => undefined }, maintenant: () => new Date("2027-01-11T00:00:00Z") } as unknown as PortsIdentifiants;
    await expect(identifiantsPourTache(p, T, "tache-1")).rejects.toMatchObject({ code: "base_gelee" });
  });

  it("[A-254] rejouée, la bascule ne refait rien de plus ; une base non active n'est pas gelée par erreur", async () => {
    const m = monde();
    await m.etape.faire(T, D);
    const n = m.ordre.length;
    expect(await m.etape.dejaFait(T, D)).toBe(true);
    m.base.etat = "en_creation";
    await expect(m.etape.faire(T, D)).rejects.toMatchObject({ code: "base_non_active" });
    expect(m.ordre).toHaveLength(n);
  });

  it("[C-609] pendant un gel pour litige, la base n'est pas gelée par cette étape", async () => {
    const m = monde(true);
    await expect(m.etape.faire(T, D)).rejects.toMatchObject({ motif: "gel_pour_litige" });
    expect(m.ordre).toEqual([]);
  });
});
