import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cleDIntention } from "../../../../packages/contrats/src/commun/idempotence.js";
import { magasinEnMemoire, type Ref } from "./expediteur.js";
import { creerRelais, fileEnMemoire } from "./relais.js";

const TENANT = randomUUID();
const ligne = (n: number, destination: "hub" | "crm" = "hub") => ({ tenantId: TENANT, destination, route: "/api/console/v1/devis", methode: "POST" as const, corps: { n }, cle: cleDIntention(destination, `r-${n}`) });
function monter(ouvert: { hub: boolean; crm: boolean } = { hub: true, crm: true }) {
  const magasin = magasinEnMemoire();
  const envoyes: string[] = [];
  const executer = async (r: Ref) => { envoyes.push(String((magasin.lignes().find((l) => l.id === r.id)!.corps as { n: number }).n)); await magasin.conclure(r, { etat: "envoye" }); };
  const files = { hub: fileEnMemoire(executer), crm: fileEnMemoire(executer) };
  const horloge = { t: Date.now() };
  const relais = creerRelais({ magasin, files, ouverte: (d) => ouvert[d], maintenant: () => horloge.t });
  return { magasin, files, relais, envoyes, horloge, ouvert };
}

describe("relais de la boîte d'envoi", () => {
  it("[A-088] [C-483] @envoi le Hub coupé puis rétabli : rien perdu, tout rejoué dans l'ordre", async () => {
    const m = monter({ hub: false, crm: true });
    for (let n = 1; n <= 5; n++) m.magasin.deposer({ ...ligne(n), creeLe: new Date(m.horloge.t + n) });
    await m.relais.balayer();
    await m.files.hub.vider();
    expect(m.envoyes).toEqual([]);
    expect(m.magasin.lignes().every((l) => l.etat === "a_envoyer")).toBe(true);
    m.ouvert.hub = true;
    m.horloge.t += 10;
    await m.relais.balayer();
    await m.files.hub.vider();
    expect(m.envoyes).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("[C-402] une file par destination : chaque ligne part dans la file de sa destination", async () => {
    const m = monter();
    m.magasin.deposer(ligne(1, "hub"));
    m.magasin.deposer(ligne(2, "crm"));
    await m.relais.balayer();
    expect(m.files.hub.jobs()).toHaveLength(1);
    expect(m.files.crm.jobs()).toHaveLength(1);
  });

  it("[C-535] @anti-doublon le jobId de la tâche est la clé : un second balayage n'ajoute rien", async () => {
    const m = monter();
    const ref = m.magasin.deposer(ligne(1));
    await m.relais.balayer();
    await m.relais.balayer();
    const cle = m.magasin.lignes().find((l) => l.id === ref.id)!.cle;
    expect(m.files.hub.jobs()).toEqual([cle]);
  });

  it("[A-088] @envoi après un arrêt brutal, une ligne en cours depuis plus de 2 minutes repasse à envoyer avec la même clé", async () => {
    const m = monter();
    const ref = m.magasin.deposer(ligne(1));
    const cle = m.magasin.lignes()[0]!.cle;
    await m.magasin.prendre(ref, new Date(m.horloge.t));
    await m.relais.balayer();
    expect(m.magasin.lignes()[0]!.etat).toBe("en_cours");
    m.horloge.t += 121_000;
    const r = await m.relais.balayer();
    expect(r.reprises).toBe(1);
    expect([m.magasin.lignes()[0]!.etat, m.magasin.lignes()[0]!.cle]).toEqual(["a_envoyer", cle]);
  });

  it("[C-403] @envoi une ligne renvoyée après échec est redéposée même si l'ancienne tâche existe encore", async () => {
    const m = monter();
    const ref = m.magasin.deposer(ligne(1));
    await m.relais.balayer();
    await m.files.hub.vider();
    await m.magasin.conclure(ref, { etat: "echec", erreur: "porte_fermee" });
    await m.magasin.renvoyer(ref);
    await m.relais.balayer();
    await m.files.hub.vider();
    expect(m.envoyes).toEqual(["1", "1"]);
  });

  it("[A-088] @envoi Valkey vidé pendant que des lignes attendent : aucune perdue, aucune doublée", async () => {
    const m = monter();
    for (let n = 1; n <= 100; n++) m.magasin.deposer({ ...ligne(n), creeLe: new Date(m.horloge.t + n) });
    await m.relais.balayer();
    m.files.hub.perdre();
    await m.relais.balayer();
    await m.relais.balayer();
    await m.files.hub.vider();
    expect(m.envoyes).toHaveLength(100);
    expect(new Set(m.envoyes).size).toBe(100);
  });
});
