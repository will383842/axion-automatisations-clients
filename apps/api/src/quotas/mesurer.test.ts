import { describe, expect, it } from "vitest";
import type { Connexion, RoleConnexion, SessionDonnees } from "../donnees/service.js";
import { SQL_TAILLE_BASE, TYPE_TACHE_MESURE, deposerMesure, mesurer, personnesParListeBlanche, tailleBaseParLecture, type Mesures, type PortsMesure } from "./mesurer.js";

const T = "11111111-1111-4111-8111-111111111111";
const BASE = { tenantId: T, nomBase: "cli_11111111111141118111111111111111" };
const MAINTENANT = new Date("2026-11-02T10:30:00Z");

function ports(valeurs: { base: number; fichiers: number; personnes: number }) {
  const ecrites: Mesures[] = [];
  const p: PortsMesure = {
    async tailleBase() { return valeurs.base; },
    async tailleFichiers() { return valeurs.fichiers; },
    async personnes() { return valeurs.personnes; },
    async ecrire(_t, m) { ecrites.push(m); },
    maintenant: () => MAINTENANT,
  };
  return { p, ecrites };
}

describe("quotas : mesure réelle", () => {
  it("[A-247] la taille réelle de la base, des fichiers et le nombre de personnes sont mesurés", async () => {
    const { p, ecrites } = ports({ base: 5_000, fichiers: 7_000, personnes: 42 });
    const m = await mesurer(p, BASE);
    expect(m).toEqual({ baseOctets: 5_000, fichiersOctets: 7_000, personnes: 42, mesureLe: MAINTENANT });
    expect(ecrites).toEqual([m]);
  });

  it("[A-247] une mesure invalide n'est jamais écrite", async () => {
    for (const mauvaise of [{ base: -1, fichiers: 1, personnes: 1 }, { base: 1, fichiers: 1.5, personnes: 1 }, { base: 1, fichiers: 1, personnes: Number.NaN }]) {
      const { p, ecrites } = ports(mauvaise);
      await expect(mesurer(p, BASE)).rejects.toThrow();
      expect(ecrites).toEqual([]);
    }
  });

  it("[A-247] la taille de la base est lue avec le rôle de lecture seulement", async () => {
    const ouvertures: string[] = [];
    const requetes: string[] = [];
    const ouvrir = async (nomBase: string, role: RoleConnexion): Promise<Connexion> => {
      ouvertures.push(`${nomBase}/${role}`);
      return { async requete(texte) { requetes.push(texte); return [{ octets: 123 }]; }, async fermer() {} };
    };
    expect(await tailleBaseParLecture(ouvrir)(BASE.nomBase)).toBe(123);
    const ouvrirTexte = async (): Promise<Connexion> => ({ async requete() { return [{ octets: "123456789012" }]; }, async fermer() {} });
    expect(await tailleBaseParLecture(ouvrirTexte)(BASE.nomBase)).toBe(123_456_789_012);
    expect(ouvertures).toEqual([`${BASE.nomBase}/lecture`]);
    expect(requetes).toEqual([SQL_TAILLE_BASE]);
    expect(SQL_TAILLE_BASE).toMatch(/^SELECT pg_database_size\(current_database\(\)\)/);
    // La taille est lue en texte entier (bigint), jamais en flottant : le pilote rend une chaîne que mesurer convertit.
    expect(SQL_TAILLE_BASE).toContain("::bigint::text");
    expect(SQL_TAILLE_BASE).not.toMatch(/float/i);
  });

  it("[A-247] la connexion de mesure est toujours fermée, y compris sur erreur", async () => {
    let fermetures = 0;
    const ouvrirOk = async (): Promise<Connexion> => ({ async requete() { return [{ octets: 1 }]; }, async fermer() { fermetures++; } });
    await tailleBaseParLecture(ouvrirOk)(BASE.nomBase);
    expect(fermetures).toBe(1);
    const ouvrirKo = async (): Promise<Connexion> => ({ async requete() { throw new Error("panne"); }, async fermer() { fermetures++; } });
    await expect(tailleBaseParLecture(ouvrirKo)(BASE.nomBase)).rejects.toThrow("panne");
    expect(fermetures).toBe(2);
  });

  it("[A-247] les personnes sont comptées par la requête de la liste blanche, en équipe, métadonnées seulement", async () => {
    const vus: { session: SessionDonnees; nom: string }[] = [];
    const service = { async executer(session: SessionDonnees, nom: string) { vus.push({ session, nom }); return [{ total: 17 }]; } };
    expect(await personnesParListeBlanche(service)(T)).toBe(17);
    expect(vus).toHaveLength(1);
    expect(vus[0]!.nom).toBe("compterPersonnes");
    expect(vus[0]!.session).toMatchObject({ tenantId: T, role: "equipe", etablissements: [] });
    expect(vus[0]!.session.vue).toBeUndefined();
  });

  it("[A-247] la tâche horaire a pour jobId la base et l'heure : deux dépôts dans la même heure n'en font qu'une", async () => {
    const ajouts: { nom: string; jobId: string | undefined }[] = [];
    const file = { name: "quotas", async add(nom: string, _d: unknown, opts?: { jobId?: string }) { ajouts.push({ nom, jobId: opts?.jobId }); return undefined; } };
    await deposerMesure(file, BASE, new Date("2026-11-02T10:01:00Z"));
    await deposerMesure(file, BASE, new Date("2026-11-02T10:59:59Z"));
    await deposerMesure(file, BASE, new Date("2026-11-02T11:00:00Z"));
    await deposerMesure(file, { ...BASE, nomBase: "cli_autre" }, new Date("2026-11-02T10:01:00Z"));
    expect(ajouts.every((a) => a.nom === TYPE_TACHE_MESURE)).toBe(true);
    expect(ajouts[0]!.jobId).toBe(ajouts[1]!.jobId);
    expect(new Set(ajouts.map((a) => a.jobId)).size).toBe(3);
  });
});
