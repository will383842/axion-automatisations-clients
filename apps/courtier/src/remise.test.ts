import { describe, expect, it } from "vitest";
import { creerJournal } from "./journal.js";
import { creerRegistreJetons } from "./jetons.js";
import { ErreurRemise, remettre, type Connexion, type PortsRemise } from "./remise.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "33333333-3333-4333-8333-333333333333";
const INSTANCE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INSTANCE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXEC = "22222222-2222-4222-8222-222222222222";
const CONN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MARQUEUR_ACCES = "marqueur-acces-4f9d2c7e1b";
const MARQUEUR_RENOUVELLEMENT = "marqueur-renouvellement-8a31c0de55";
const MARQUEUR_MOT_DE_PASSE = "marqueur-mdp-61be90aa37";
const T0 = 1_800_000_000_000;

const connexions: Record<string, Connexion> = {
  [INSTANCE_A]: { tenantId: A, celluleCode: "cellule-1", famille: "oauth", referenceCoffre: `bao:clients/${A}/d0d0d0d0-0000-4000-8000-000000000001`, portees: ["messagerie.lire"] },
  [INSTANCE_B]: { tenantId: B, celluleCode: "cellule-2", famille: "oauth", referenceCoffre: `bao:clients/${B}/d0d0d0d0-0000-4000-8000-000000000002`, portees: ["messagerie.lire"] },
};

function ports(sur: Partial<PortsRemise> = {}) {
  const lus: string[] = [];
  const lignes: string[] = [];
  const p: PortsRemise = {
    verifierJetonInstance: async () => true,
    connexion: async (instance) => connexions[instance],
    lireCoffre: async (chemin) => {
      lus.push(chemin);
      return { access_token: MARQUEUR_ACCES, refresh_token: MARQUEUR_RENOUVELLEMENT, expires_at: Math.floor(T0 / 1000) + 3600, mot_de_passe: MARQUEUR_MOT_DE_PASSE };
    },
    jetons: creerRegistreJetons({ maintenant: () => T0 }),
    journal: creerJournal((l) => lignes.push(l)),
    maintenant: () => T0,
    dureeExecutionMs: 600_000,
    ...sur,
  };
  return { p, lus, lignes };
}
const demande = (instanceId: string, executionId = EXEC) => ({ instanceId, executionId, connexionId: CONN });
const appelant = (cellule: string) => ({ cellule, jetonInstance: "ji1.x.y" });
const code = async (f: Promise<unknown>) => (await f.then(() => null, (e: unknown) => e)) as ErreurRemise | null;

describe("remise", () => {
  it("[C-014] @isolation une remise demandée par la cellule 1 pour une instance de la cellule 2 est refusée", async () => {
    const { p, lus } = ports();
    const e = await code(remettre(p, appelant("cellule-1"), demande(INSTANCE_B)));
    expect(e).toBeInstanceOf(ErreurRemise);
    expect(e?.code).toBe("refusee");
    expect(lus).toEqual([]); // le coffre n'est même pas interrogé
    // instance inconnue ou jeton d'instance refusé : même code, aucune raison donnée
    expect((await code(remettre(p, appelant("cellule-1"), demande("dddddddd-dddd-4ddd-8ddd-dddddddddddd"))))?.code).toBe("refusee");
    const refus = ports({ verifierJetonInstance: async () => false });
    expect((await code(remettre(refus.p, appelant("cellule-1"), demande(INSTANCE_A))))?.code).toBe("refusee");
    expect(refus.lus).toEqual([]);
  });

  it("[C-014] une instance sans cellule n'est servie à aucune cellule", async () => {
    const { p } = ports({ connexion: async () => ({ ...connexions[INSTANCE_A]!, celluleCode: null }) });
    expect((await code(remettre(p, appelant("cellule-1"), demande(INSTANCE_A))))?.code).toBe("refusee");
  });

  it("[A-334] la remise OAuth ne contient jamais le jeton de renouvellement", async () => {
    const { p, lignes } = ports();
    const r = await remettre(p, appelant("cellule-1"), demande(INSTANCE_A));
    expect(r).toEqual({ type: "oauth", jetonAcces: MARQUEUR_ACCES, expire: new Date(T0 + 600_000 + 60_000).toISOString() });
    expect(JSON.stringify(r)).not.toContain(MARQUEUR_RENOUVELLEMENT);
    expect(JSON.stringify(r)).not.toContain(MARQUEUR_MOT_DE_PASSE);
    expect(lignes.join("\n")).not.toContain(MARQUEUR_RENOUVELLEMENT);
  });

  it("[A-392] la valeur lue vient de clients/data/<tenant>/… et d'aucun autre chemin", async () => {
    const { p, lus } = ports();
    await remettre(p, appelant("cellule-1"), demande(INSTANCE_A));
    expect(lus).toEqual([`clients/data/${A}/d0d0d0d0-0000-4000-8000-000000000001`]);
    for (const reference of [`bao:clients/${B}/d0d0d0d0-0000-4000-8000-000000000002`, `bao:technique/echanges/c1/k1`, `bao:clients/${A}/../${B}/x`, `clients/${A}/x`]) {
      const autre = ports({ connexion: async () => ({ ...connexions[INSTANCE_A]!, referenceCoffre: reference }) });
      expect((await code(remettre(autre.p, appelant("cellule-1"), demande(INSTANCE_A))))?.code).toBe("refusee");
      expect(autre.lus).toEqual([]);
    }
  });

  it("[A-337] après une remise, la valeur n'existe ni dans le registre ni dans le journal ; aucune écriture disque", async () => {
    const { p, lignes } = ports();
    await remettre(p, appelant("cellule-1"), demande(INSTANCE_A));
    const vue = JSON.stringify([...p.jetons.empreintesPourEssai()]) + lignes.join("\n");
    for (const m of [MARQUEUR_ACCES, MARQUEUR_RENOUVELLEMENT, MARQUEUR_MOT_DE_PASSE]) expect(vue).not.toContain(m);
    expect(lignes.length).toBeGreaterThan(0);
  });

  it("une erreur du coffre ou une valeur illisible ne laisse sortir aucune valeur", async () => {
    const piege = ports({ lireCoffre: async () => { throw new Error(`panne ${MARQUEUR_ACCES}`); } });
    const e = await code(remettre(piege.p, appelant("cellule-1"), demande(INSTANCE_A)));
    expect(e?.code).toBe("coffre_indisponible");
    expect(`${e?.message}${JSON.stringify(e)}${piege.lignes.join("\n")}`).not.toContain(MARQUEUR_ACCES);
    const vide = ports({ lireCoffre: async () => ({ refresh_token: MARQUEUR_RENOUVELLEMENT }) });
    const e2 = await code(remettre(vide.p, appelant("cellule-1"), demande(INSTANCE_A)));
    expect(e2?.code).toBe("valeur_invalide");
    expect(`${e2?.message}${vide.lignes.join("\n")}`).not.toContain(MARQUEUR_RENOUVELLEMENT);
  });

  it("une demande rejouée (même exécution) ou portant un paramètre en plus est refusée", async () => {
    const { p } = ports();
    await remettre(p, appelant("cellule-1"), demande(INSTANCE_A));
    expect((await code(remettre(p, appelant("cellule-1"), demande(INSTANCE_A))))?.code).toBe("deja_remise");
    const large = { ...demande(INSTANCE_A, "44444444-4444-4444-8444-444444444444"), portees: ["tout"] };
    expect((await code(remettre(p, appelant("cellule-1"), large)))?.code).toBe("demande_invalide");
    expect((await code(remettre(p, appelant("cellule-1"), { ...demande(INSTANCE_A), tenantId: B })))?.code).toBe("demande_invalide");
  });

  it("la messagerie reçoit un jeton court lié au client, à l'exécution et aux portées déclarées, jamais le mot de passe", async () => {
    const { p } = ports({ connexion: async () => ({ ...connexions[INSTANCE_A]!, famille: "messagerie" }) });
    const r = await remettre(p, appelant("cellule-1"), demande(INSTANCE_A));
    if (r.type !== "mandataire") throw new Error("type inattendu");
    expect(p.jetons.lire(r.jeton)).toEqual({ tenantId: A, executionId: EXEC, portees: ["messagerie.lire"] });
    expect(JSON.stringify(r)).not.toContain(MARQUEUR_MOT_DE_PASSE);
  });
});
