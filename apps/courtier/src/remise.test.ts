import { describe, expect, it, vi } from "vitest";
import { creerJournal } from "./journal.js";
import { creerRegistreJetons } from "./jetons.js";
import { ErreurRemise, remettre, type Connexion, type PortsRemise } from "./remise.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "33333333-3333-4333-8333-333333333333";
const INSTANCE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INSTANCE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXEC = "22222222-2222-4222-8222-222222222222";
const CONN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONN_AUTRE_MODULE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MARQUEUR_ACCES = "marqueur-acces-4f9d2c7e1b";
const MARQUEUR_RENOUVELLEMENT = "marqueur-renouvellement-8a31c0de55";
const MARQUEUR_MOT_DE_PASSE = "marqueur-mdp-61be90aa37";
const T0 = 1_800_000_000_000;

// Le faux filtre sur le COUPLE (instanceId, connexionId), comme la table connexions sous RLS : une connexion
// d'un autre module du même client n'est pas servie pour cette instance.
const lignes_connexions: Connexion[] = [
  { instanceId: INSTANCE_A, connexionId: CONN, tenantId: A, celluleCode: "cellule-1", famille: "oauth", referenceCoffre: `bao:clients/${A}/d0d0d0d0-0000-4000-8000-000000000001`, portees: ["messagerie.lire", "messagerie.envoyer"], porteesModule: ["messagerie.lire", "contacts.lire"] },
  { instanceId: INSTANCE_B, connexionId: CONN, tenantId: B, celluleCode: "cellule-2", famille: "oauth", referenceCoffre: `bao:clients/${B}/d0d0d0d0-0000-4000-8000-000000000002`, portees: ["messagerie.lire"], porteesModule: ["messagerie.lire"] },
  { instanceId: "99999999-9999-4999-8999-999999999999", connexionId: CONN_AUTRE_MODULE, tenantId: A, celluleCode: "cellule-1", famille: "oauth", referenceCoffre: `bao:clients/${A}/d0d0d0d0-0000-4000-8000-000000000003`, portees: ["messagerie.lire"], porteesModule: ["messagerie.lire"] },
];
const connexions: Record<string, Connexion> = { [INSTANCE_A]: lignes_connexions[0]!, [INSTANCE_B]: lignes_connexions[1]! };

function ports(sur: Partial<PortsRemise> = {}) {
  const lus: string[] = [];
  const lignes: string[] = [];
  const p: PortsRemise = {
    verifierJetonInstance: async () => true,
    connexion: async (instance, connexion) => lignes_connexions.find((c) => c.instanceId === instance && c.connexionId === connexion),
    executionEnCours: async () => true,
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
const demande = (instanceId: string, executionId = EXEC, connexionId = CONN) => ({ instanceId, executionId, connexionId });
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
    expect(p.jetons.lire(r.jeton)).toEqual({ tenantId: A, instanceId: INSTANCE_A, connexionId: CONN, executionId: EXEC, portees: ["messagerie.lire"] }); // intersection connexion ∩ module
    expect(JSON.stringify(r)).not.toContain(MARQUEUR_MOT_DE_PASSE);
  });

  it("[A-337] la messagerie ne fait pas lire le mot de passe au courtier : le coffre n'est pas interrogé", async () => {
    const { p, lus } = ports({ connexion: async () => ({ ...connexions[INSTANCE_A]!, famille: "messagerie" }) });
    await remettre(p, appelant("cellule-1"), demande(INSTANCE_A));
    expect(lus).toEqual([]);
  });

  it("[C-014] @isolation une exécution inconnue, terminée ou d'une autre instance est refusée, coffre non interrogé", async () => {
    const vues: unknown[] = [];
    const { p, lus } = ports({ executionEnCours: async (e) => { vues.push(e); return false; } });
    expect((await code(remettre(p, appelant("cellule-1"), demande(INSTANCE_A))))?.code).toBe("refusee");
    expect(lus).toEqual([]);
    expect(vues).toEqual([{ executionId: EXEC, instanceId: INSTANCE_A, cellule: "cellule-1" }]);
    // refusée sans consommer la réservation : l'exécution en cours peut ensuite être servie
    const bon = ports({ executionEnCours: async (e) => e.executionId === EXEC && e.instanceId === INSTANCE_A && e.cellule === "cellule-1" });
    expect((await code(remettre(bon.p, appelant("cellule-1"), demande(INSTANCE_A, "44444444-4444-4444-8444-444444444444"))))?.code).toBe("refusee");
    expect(bon.lus).toEqual([]);
    expect(await remettre(bon.p, appelant("cellule-1"), demande(INSTANCE_A))).toMatchObject({ type: "oauth" });
    // une panne du port refuse aussi
    const panne = ports({ executionEnCours: async () => { throw new Error("panne"); } });
    expect((await code(remettre(panne.p, appelant("cellule-1"), demande(INSTANCE_A))))?.code).toBe("refusee");
    expect(panne.lus).toEqual([]);
  });

  it("[C-014] @isolation une connexion d'un autre module du même client est refusée pour cette instance", async () => {
    const { p, lus } = ports();
    expect((await code(remettre(p, appelant("cellule-1"), demande(INSTANCE_A, EXEC, CONN_AUTRE_MODULE))))?.code).toBe("refusee");
    expect(lus).toEqual([]);
    // un port qui rendrait la ligne d'un autre couple est écarté par le courtier lui-même
    const trompeur = ports({ connexion: async () => lignes_connexions[2] });
    expect((await code(remettre(trompeur.p, appelant("cellule-1"), demande(INSTANCE_A))))?.code).toBe("refusee");
    expect(trompeur.lus).toEqual([]);
  });

  it("[C-014] la remise OAuth refuse un jeton fournisseur dont la durée restante est trop courte", async () => {
    const court = ports({ lireCoffre: async () => ({ access_token: MARQUEUR_ACCES, expires_at: Math.floor(T0 / 1000) + 10 }) });
    expect((await code(remettre(court.p, appelant("cellule-1"), demande(INSTANCE_A))))?.code).toBe("valeur_invalide");
    expect(court.lignes.join("\n")).not.toContain(MARQUEUR_ACCES);
    // la réservation est rendue : une fois le coffre rafraîchi, la même exécution est servie
    court.p.lireCoffre = async () => ({ access_token: MARQUEUR_ACCES, expires_at: Math.floor(T0 / 1000) + 3600 });
    expect(await remettre(court.p, appelant("cellule-1"), demande(INSTANCE_A))).toMatchObject({ type: "oauth" });
  });

  it("[A-337] un appel de coffre qui ne répond pas échoue après le délai (horloge factice), abandonné et la réservation libérée", async () => {
    const taches: Array<() => void> = [];
    let signal: AbortSignal | undefined;
    let appels = 0;
    const { p } = ports({
      lireCoffre: (_chemin, s) => { appels += 1; signal = s; return appels === 1 ? new Promise<Record<string, unknown>>(() => undefined) : Promise.resolve({ access_token: MARQUEUR_ACCES, expires_at: Math.floor(T0 / 1000) + 3600 }); },
      planifier: (f) => { taches.push(f); return () => { const i = taches.indexOf(f); if (i >= 0) taches.splice(i, 1); }; },
      delaiCoffreMs: 5000,
    });
    const attente = code(remettre(p, appelant("cellule-1"), demande(INSTANCE_A)));
    await vi.waitFor(() => expect(appels).toBe(1)); // le coffre est appelé : son échéance est la seule en attente
    expect(taches.length).toBe(1);
    taches.splice(0).forEach((f) => f());
    expect((await attente)?.code).toBe("coffre_indisponible");
    expect(signal?.aborted).toBe(true);
    // la réservation est libérée : une nouvelle demande de la même exécution peut aboutir
    await expect(remettre(p, appelant("cellule-1"), demande(INSTANCE_A))).resolves.toMatchObject({ type: "oauth" });
  });

  it("[C-014] un port d'API ou de base qui ne répond pas (jeton, connexion, exécution) donne « refusee » après le délai, coffre non interrogé", async () => {
    for (const port of ["verifierJetonInstance", "connexion", "executionEnCours"] as const) {
      const taches: Array<() => void> = [];
      let appele = false;
      const { p, lus } = ports({ [port]: () => { appele = true; return new Promise(() => undefined); }, planifier: (f) => { taches.push(f); return () => { const i = taches.indexOf(f); if (i >= 0) taches.splice(i, 1); }; }, delaiPortsMs: 5000 } as Partial<PortsRemise>);
      const attente = code(remettre(p, appelant("cellule-1"), demande(INSTANCE_A)));
      await vi.waitFor(() => expect(appele).toBe(true));
      expect(taches.length).toBe(1);
      taches.splice(0).forEach((f) => f());
      expect((await attente)?.code).toBe("refusee");
      expect(lus).toEqual([]);
    }
  });
});
