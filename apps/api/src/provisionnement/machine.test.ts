import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { creerMachine, ErreurEtape, ESSAIS_MAX, OPTIONS_TACHE, idTacheProvisionnement, type Etape, type LigneBase, type Registre } from "./machine.js";

const T = randomUUID();
function monter(etat: LigneBase["etat"] = "en_creation", etape = 0) {
  let ligne: LigneBase | undefined = { etat, etape, grappe: "a_choisir", nomBase: "cli_x" };
  const erreurs: (string | null)[] = [];
  const alertes: { type: string; clientId: string; code: string }[] = [];
  const registre: Registre = {
    lire: async () => ligne,
    enregistrerEtape: async (_t, n) => { if (ligne) ligne = { ...ligne, etape: Math.max(ligne.etape, n) }; erreurs.push(null); },
    noterErreur: async (_t, code) => { erreurs.push(code); },
  };
  const faits = new Set<number>();
  const appels: string[] = [];
  const cassee = new Set<number>();
  const etape_ = (numero: number): Etape<{ tenantId: string }> => ({
    numero,
    nom: `e${numero}`,
    dejaFait: async () => faits.has(numero),
    faire: async () => { appels.push(`faire${numero}`); if (cassee.has(numero)) throw new ErreurEtape("panne_essai"); faits.add(numero); },
  });
  const machine = creerMachine({ etapes: [1, 2, 3, 7].map(etape_), registre, alertes: { envoyer: async (a) => void alertes.push(a) }, contexte: (tenantId) => ({ tenantId }) });
  return { machine, appels, faits, cassee, alertes, erreurs, ligne: () => ligne, registre };
}

describe("machine de provisionnement", () => {
  it("[A-213] la machine reprend à l'étape suivante après un échec, sans refaire ce qui est fait", async () => {
    const m = monter();
    m.cassee.add(3);
    await expect(m.machine.executer(T)).rejects.toThrow();
    expect(m.appels).toEqual(["faire1", "faire2", "faire3"]);
    expect(m.ligne()?.etape).toBe(2);
    m.cassee.delete(3);
    await m.machine.executer(T);
    expect(m.appels).toEqual(["faire1", "faire2", "faire3", "faire3", "faire7"]);
    expect(m.ligne()?.etape).toBe(7);
  });

  it("[A-213] dejaFait vérifie l'état réel : une étape notée faite mais disparue est refaite", async () => {
    const m = monter("en_creation", 7);
    await m.machine.executer(T);
    expect(m.appels).toEqual(["faire1", "faire2", "faire3", "faire7"]);
  });

  it("[A-213] une base déjà active ou absente ne relance aucune étape", async () => {
    const m = monter("active", 9);
    expect(await m.machine.executer(T)).toBe("ignore");
    expect(m.appels).toEqual([]);
  });

  it("[A-213] la tâche a un identifiant par client, sans deux-points (refusé par BullMQ), et jamais plus de données que le client", () => {
    expect(idTacheProvisionnement(T)).toBe(`provision-${T}`);
    expect(idTacheProvisionnement(T)).not.toContain(":");
    expect(() => idTacheProvisionnement("x'; DROP")).toThrow();
  });

  it("[A-224] un échec laisse la base en_creation, range le code, envoie l'alerte provisionnement_echec et se reprend", async () => {
    const m = monter();
    m.cassee.add(2);
    await expect(m.machine.executer(T)).rejects.toThrow("panne_essai");
    expect(m.ligne()?.etat).toBe("en_creation");
    expect(m.erreurs).toContain("panne_essai");
    expect(m.alertes).toEqual([{ type: "provisionnement_echec", clientId: T, code: "panne_essai" }]);
    m.cassee.clear();
    expect(await m.machine.executer(T)).toBe("a_jour");
  });

  it("[A-224] jusqu'à 5 essais avec attente croissante ; une erreur inattendue n'expose que le code erreur_inattendue", async () => {
    expect(ESSAIS_MAX).toBe(5);
    expect(OPTIONS_TACHE).toMatchObject({ attempts: 5, backoff: { type: "exponential" } });
    const m = monter();
    m.cassee.add(1);
    const etapes: Etape<{ tenantId: string }>[] = [{ numero: 1, nom: "x", dejaFait: async () => false, faire: async () => { throw new Error("valeur sensible VALEUR-SENSIBLE-A"); } }];
    const brute = creerMachine({ etapes, registre: m.registre, alertes: { envoyer: async (a) => void m.alertes.push(a) }, contexte: (tenantId) => ({ tenantId }) });
    await expect(brute.executer(T)).rejects.toThrow("erreur_inattendue");
    expect(JSON.stringify([m.erreurs, m.alertes])).not.toContain("VALEUR-SENSIBLE-A");
  });

  it("[A-215] sans ligne bases_client pour le client, la machine n'exécute rien et envoie l'alerte", async () => {
    const m = monter();
    const vide = creerMachine({ etapes: [], registre: { ...m.registre, lire: async () => undefined }, alertes: { envoyer: async (a) => void m.alertes.push(a) }, contexte: (tenantId) => ({ tenantId }) });
    expect(await vide.executer(T)).toBe("ligne_absente");
    expect(m.alertes).toEqual([{ type: "provisionnement_echec", clientId: T, code: "ligne_absente" }]);
  });

  it("[A-224] un tenantId en majuscules est normalisé avant le try : l'échec est rangé avec son code et alerté sous l'identifiant en minuscules", async () => {
    const m = monter();
    m.cassee.add(1);
    await expect(m.machine.executer(T.toUpperCase())).rejects.toThrow("panne_essai");
    expect(m.erreurs).toContain("panne_essai");
    expect(m.alertes).toEqual([{ type: "provisionnement_echec", clientId: T, code: "panne_essai" }]);
    expect(idTacheProvisionnement(T.toUpperCase())).toBe(`provision-${T}`);
  });

  it("[A-213] @anti-doublon un verrou par client : une exécution qui chevauche une autre n'exécute aucune étape", async () => {
    const m = monter();
    const pris: string[] = [];
    let libre = true;
    const verrou = { prendre: async (t: string) => { if (!libre) return undefined; libre = false; pris.push(t); return async () => { libre = true; }; } };
    const etapes: Etape<{ tenantId: string }>[] = [{ numero: 1, nom: "lente", dejaFait: async () => false, faire: async () => { expect(await seconde.executer(T)).toBe("occupe"); } }];
    const seconde = creerMachine({ etapes, registre: m.registre, alertes: { envoyer: async () => undefined }, contexte: (tenantId) => ({ tenantId }), verrou });
    expect(await seconde.executer(T)).toBe("a_jour");
    expect(pris).toEqual([T]);
    expect(libre).toBe(true);
  });

  it("[A-213] le verrou est rendu même quand une étape échoue", async () => {
    const m = monter();
    let libre = true;
    const verrou = { prendre: async () => { libre = false; return async () => { libre = true; }; } };
    const casse: Etape<{ tenantId: string }>[] = [{ numero: 1, nom: "x", dejaFait: async () => false, faire: async () => { throw new ErreurEtape("panne_essai"); } }];
    const machine = creerMachine({ etapes: casse, registre: m.registre, alertes: { envoyer: async () => undefined }, contexte: (tenantId) => ({ tenantId }), verrou });
    await expect(machine.executer(T)).rejects.toThrow();
    expect(libre).toBe(true);
  });
});
