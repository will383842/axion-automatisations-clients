import { describe, expect, it } from "vitest";
import { creerServiceDonnees, type PortsDonnees, type SessionDonnees } from "./service.js";

// Fermeture des pools inactifs par minuterie (T2-37c, dette 3 de LOT2-dette-T2-37) : un pool inactif est fermé après le délai, une requête en cours n'est jamais interrompue.
const A = "11111111-1111-4111-8111-111111111111";
const session: SessionDonnees = { tenantId: A, role: "client", acteur: "u1", etablissements: [] };

function monde() {
  let t = Date.parse("2026-11-02T10:00:00Z");
  const fermes: string[] = [];
  let liberer!: () => void;
  const ports: PortsDonnees = {
    base: async () => ({ nomBase: "cli_1111", etat: "active" }),
    ouvrir: async (b, r) => ({ requete: async () => { if (r === "app") await new Promise<void>((ok) => { liberer = ok; }); return []; }, fermer: async () => void fermes.push(b) }),
    accordValide: async () => false,
    vueRangee: () => undefined,
    maintenant: () => new Date(t),
  };
  return { service: creerServiceDonnees(ports), fermes, avancer: (ms: number) => { t += ms; }, liberer: () => liberer() };
}

describe("fermeture des pools par minuterie", () => {
  it("[A-170] la minuterie ferme un pool inactif après le délai, et rend un arrêt qui la coupe", async () => {
    const m = monde();
    await m.service.executer(session, "compterPersonnes", {});
    const tics: (() => void)[] = [];
    const arret = m.service.planifierBalayage(300_000, { setInterval: (f) => { tics.push(f); return tics.length; }, clearInterval: () => void tics.splice(0) });
    m.avancer(100_000);
    tics[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.fermes).toEqual([]);
    m.avancer(300_000);
    tics[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.fermes).toEqual(["cli_1111"]);
    arret();
    expect(tics).toEqual([]);
  });

  it("[A-170] une requête en cours n'est jamais interrompue par le balayage, même après le délai", async () => {
    const m = monde();
    const ecriture: SessionDonnees = { ...session };
    const ecrire = { ...(await import("./requetes/liste.js")).LISTE_BLANCHE };
    const { z } = await import("zod");
    const svc = creerServiceDonnees({ base: async () => ({ nomBase: "cli_1111", etat: "active" }), ouvrir: async (b, r) => ({ requete: async () => { if (r === "app") await new Promise<void>((ok) => { m.liberer = ok; }); return []; }, fermer: async () => void m.fermes.push(b) }), accordValide: async () => false, vueRangee: () => undefined, maintenant: () => new Date(Date.parse("2026-11-02T10:00:00Z") + 0) }, { ...ecrire, ecrireListe: { nom: "ecrireListe", schema: z.object({}), sql: "UPDATE commun.listes_prospects SET nom = nom WHERE {{filtre}}", mode: "ecriture", metadonnees: false, parEtablissement: true, colonnes: [], valeurs: () => [] } });
    const enCours = svc.executer(ecriture, "ecrireListe", {});
    await new Promise((r) => setTimeout(r, 0));
    await svc.balayer(-1);
    expect(m.fermes).toEqual([]);
    m.liberer();
    await enCours;
    await svc.balayer(-1);
    expect(m.fermes).toEqual(["cli_1111"]);
  });
});
