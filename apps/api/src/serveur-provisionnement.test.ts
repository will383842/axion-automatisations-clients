import { describe, expect, it } from "vitest";
import { ErreurEtape } from "./provisionnement/machine.js";
import { construireServeur, creerTravailleurProvisionnement, exigerEquipeParRole } from "./serveur.js";

// Dette T2-34 n° 2 (propriétaire T2-35) : le Worker et la route de reprise, fermés tant qu'on ne les fournit pas.
const CLIENT = "11111111-1111-4111-8111-111111111111";
const url = `/api/console/v1/clients/${CLIENT}/base/reprendre`;
function serveurAvec(role: string | undefined, equipe = true) {
  const deposes: string[] = [];
  const s = construireServeur({
    provisionnement: {
      exigerEquipe: exigerEquipeParRole(async () => (role === undefined ? undefined : { equipe, role })),
      etatBase: async () => "en_creation",
      reprendre: async (t) => void deposes.push(t),
    },
  });
  return { s, deposes };
}

describe("câblage du provisionnement dans le serveur", () => {
  it("[A-224] sans dépendance fournie, la route de reprise n'existe pas (interrupteur fermé)", async () => {
    const s = construireServeur();
    expect((await s.inject({ method: "POST", url })).statusCode).toBe(404);
  });
  it("[A-224] @isolation la route de reprise refuse lecteur, qualifieur, un rôle hors équipe et l'absence de session ; l'équipe passe", async () => {
    for (const [role, equipe] of [["lecteur", true], ["qualifieur", true], ["admin", false], [undefined, true]] as const) {
      const r = serveurAvec(role, equipe);
      expect((await r.s.inject({ method: "POST", url })).statusCode, String(role)).toBe(403);
      expect(r.deposes).toEqual([]);
    }
    const ok = serveurAvec("admin");
    expect((await ok.s.inject({ method: "POST", url })).statusCode).toBe(202);
    expect(ok.deposes).toEqual([CLIENT]);
  });
  it("[A-213] le Worker n'exécute que le tenantId de la tâche et rend « occupé » comme une erreur réessayable", async () => {
    let traitement: ((job: { data: unknown }) => Promise<unknown>) | undefined;
    let options: Record<string, unknown> = {};
    const appels: string[] = [];
    creerTravailleurProvisionnement({
      fabrique: (nom, f, o) => { traitement = f; options = { nom, ...o }; return { close: async () => undefined }; },
      connexion: {} as never,
      machine: { executer: async (t) => { appels.push(t); return t === CLIENT ? "occupe" : "a_jour"; } },
    });
    expect(options).toMatchObject({ nom: "provisionnement", concurrency: 1 });
    await expect(traitement!({ data: { tenantId: CLIENT, chemin: "technique/donnees/cli_0123456789ab/app" } })).rejects.toBeInstanceOf(ErreurEtape);
    await expect(traitement!({ data: { tenantId: "22222222-2222-4222-8222-222222222222" } })).resolves.toBe("a_jour");
    expect(appels).toEqual([CLIENT, "22222222-2222-4222-8222-222222222222"]);
  });
});
