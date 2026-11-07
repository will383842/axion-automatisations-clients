import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnecteurFactice } from "../noyau/memoire/connecteur-factice.ts";
import { CLE_ARRET_GLOBAL } from "./arret-urgence.ts";
import { annulerEnvoi, cleAnnulation, DELAI_ANNULATION_MS, EnvoiAnnule, planifierEnvoiAnnulable } from "./delai-annulation.ts";
import { garderConnecteurs } from "./garde-envoi.ts";

const CLIENT = randomUUID();

class FauxValkey {
  cles = new Map<string, string>();
  injoignable = false;
  async mget(...cles: string[]) {
    if (this.injoignable) throw new Error("injoignable");
    return cles.map((c) => this.cles.get(c) ?? null);
  }
  async call(commande: string, cle = "", valeur = "", ...options: string[]): Promise<unknown> {
    if (this.injoignable) throw new Error("injoignable");
    await Promise.resolve();
    if (commande === "GET") return this.cles.get(cle) ?? null;
    const ancien = this.cles.get(cle) ?? null;
    if (options.includes("NX") && ancien !== null) return options.includes("GET") ? ancien : null;
    this.cles.set(cle, valeur);
    return options.includes("GET") ? ancien : "OK";
  }
}
function banc(executionId = "exec-1") {
  const valkey = new FauxValkey();
  const connecteur = new ConnecteurFactice();
  const garde = garderConnecteurs(connecteur, { valkey, tenantId: CLIENT, instanceId: "inst-1", executionId, annulable: true, proprietaireJeton: { clientDuJeton: async () => CLIENT }, carnet: { connait: async () => true } });
  let n = 0;
  const envoyer = () => garde.appeler("envoyer", { cle: `cle-${++n}`, element: "msg", entree: { destinataire: "client@exemple.fr", objet: "x", corps: "y" }, signal: new AbortController().signal });
  return { valkey, connecteur, envoyer };
}

describe("délai d'annulation de 10 s tenu par le serveur", () => {
  it("[C-576] planifier un envoi annulable pose un délai de 10 000 ms tenu par la file et un jobId déterministe", async () => {
    const ajouts: { nom: string; data: Record<string, unknown>; opts: { jobId?: string; delay?: number } }[] = [];
    const file = { add: async (nom: string, data: Record<string, unknown>, opts: { jobId?: string; delay?: number }) => void ajouts.push({ nom, data, opts }) };
    await planifierEnvoiAnnulable(file, { id: "exec-9", instanceId: "inst-1", clientId: CLIENT, palier: "pro" });
    expect(DELAI_ANNULATION_MS).toBe(10_000);
    expect(ajouts).toHaveLength(1);
    expect(ajouts[0]?.opts).toEqual({ jobId: "envoi-exec-9", delay: 10_000 });
    expect(ajouts[0]?.data).toMatchObject({ annulable: true, id: "exec-9" });
  });

  it("[C-576] double demande d'envoi du même brouillon : un seul travail, un seul message", async () => {
    const vus = new Map<string, unknown>();
    const file = { add: async (_n: string, data: unknown, opts: { jobId?: string }) => void (vus.has(opts.jobId ?? "") || vus.set(opts.jobId ?? randomUUID(), data)) };
    const t = { id: "exec-9", instanceId: "inst-1", clientId: CLIENT, palier: "pro" as const };
    await planifierEnvoiAnnulable(file, t);
    await planifierEnvoiAnnulable(file, t);
    expect(vus.size).toBe(1);
  });

  it("[C-576] annulé avant le départ : aucun appel, travail terminé sans échec et marqué annule", async () => {
    const b = banc();
    expect(await annulerEnvoi(b.valkey, "exec-1")).toBe("annule");
    expect(await annulerEnvoi(b.valkey, "exec-1")).toBe("deja_annule");
    const e = await b.envoyer().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EnvoiAnnule);
    expect(e).toMatchObject({ classe: "passagere", code: "envoi_annule" });
    expect(b.connecteur.appels).toHaveLength(0);
    expect(b.valkey.cles.get(cleAnnulation("exec-1"))).toBe("annule");
  });

  it("[C-576] parti puis annulé : réponse trop_tard, un seul appel ; les envois suivants de la même exécution partent", async () => {
    const b = banc();
    await b.envoyer();
    expect(await annulerEnvoi(b.valkey, "exec-1")).toBe("trop_tard");
    await b.envoyer();
    expect(b.connecteur.appels).toHaveLength(2);
    expect(b.valkey.cles.get(cleAnnulation("exec-1"))).toBe("parti");
  });

  it("[C-576] arrêt d'urgence pendant les 10 s : rien ne part", async () => {
    const b = banc();
    b.valkey.cles.set(CLE_ARRET_GLOBAL, "1");
    await expect(b.envoyer()).rejects.toMatchObject({ code: "arret_urgence" });
    expect(b.connecteur.appels).toHaveLength(0);
    expect(b.valkey.cles.has(cleAnnulation("exec-1"))).toBe(false); // l'arrêt passe avant : l'envoi n'est pas marqué « parti »
  });

  it("[C-576] Valkey injoignable au départ d'un envoi annulable : rien ne part", async () => {
    const b = banc();
    b.valkey.injoignable = true;
    await expect(b.envoyer()).rejects.toMatchObject({ classe: "passagere", code: "garde_indisponible" });
    expect(b.connecteur.appels).toHaveLength(0);
  });

  it("[C-576] course : 50 annulations et départs simultanés sur la même exécution, un seul gagnant, jamais annule et parti à la fois", async () => {
    for (let essai = 0; essai < 20; essai++) {
      const b = banc(`exec-${essai}`);
      const taches: Promise<unknown>[] = [];
      for (let i = 0; i < 25; i++) {
        taches.push(annulerEnvoi(b.valkey, `exec-${essai}`));
        taches.push(b.envoyer().then(() => "parti", () => "refuse"));
      }
      const r = await Promise.all(taches);
      const annulations = r.filter((_, i) => i % 2 === 0);
      const departs = r.filter((_, i) => i % 2 === 1);
      const final = b.valkey.cles.get(cleAnnulation(`exec-${essai}`));
      if (final === "annule") {
        expect(b.connecteur.appels).toHaveLength(0);
        expect(annulations).toContain("annule");
        expect(annulations).not.toContain("trop_tard");
        expect(departs).not.toContain("parti");
      } else {
        expect(final).toBe("parti");
        expect(annulations).not.toContain("annule");
        expect(annulations).not.toContain("deja_annule");
        expect(b.connecteur.appels.length).toBe(departs.filter((d) => d === "parti").length);
      }
    }
  });
});
