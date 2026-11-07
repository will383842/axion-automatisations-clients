import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defineAutomation } from "@axion-auto/sdk-module";
import { manifesteExemple } from "@axion-auto/sdk-module/exemples/module-exemple.ts";
import { executerAvecMoteur, type Travail } from "../files/travailleur.ts";
import { HorlogeFactice } from "../noyau/horloge.ts";
import { ConnecteurFactice } from "../noyau/memoire/connecteur-factice.ts";
import { ConsoleFactice } from "../noyau/memoire/console-factice.ts";
import { FauxMoteur } from "../noyau/postgres/faux-moteur.ts";
import { ArretEnvoisPose, CLE_ARRET_GLOBAL, cleArretClient } from "./arret-urgence.ts";
import { adresseCanonique, garderConnecteurs, type Carnet, type ProprietaireJeton } from "./garde-envoi.ts";

const A = randomUUID();
const B = randomUUID();

// Valkey simulé : MGET et SET … NX GET en une seule commande, comme le vrai.
class FauxValkey {
  cles = new Map<string, string>();
  injoignable = false;
  lectures = 0;
  async mget(...cles: string[]) {
    if (this.injoignable) throw Object.assign(new Error("injoignable"), { code: "ECONNREFUSED" });
    this.lectures++;
    return cles.map((c) => this.cles.get(c) ?? null);
  }
  async call(commande: string, ...args: string[]): Promise<unknown> {
    if (this.injoignable) throw Object.assign(new Error("injoignable"), { code: "ECONNREFUSED" });
    const [cle = "", valeur = "", ...options] = args;
    if (commande === "GET") return this.cles.get(cle) ?? null;
    const ancien = this.cles.get(cle) ?? null;
    if (options.includes("NX") && ancien !== null) return options.includes("GET") ? ancien : null;
    this.cles.set(cle, valeur);
    return options.includes("GET") ? ancien : "OK";
  }
}

interface Reglages {
  tenant?: string;
  jeton?: string | undefined;
  carnets?: Record<string, string[]>;
  sansCarnet?: boolean;
  sansJeton?: boolean;
  valkey?: FauxValkey;
}
function banc(o: Reglages = {}) {
  const valkey = o.valkey ?? new FauxValkey();
  const connecteur = new ConnecteurFactice();
  const interroges: [string, string][] = [];
  const carnet: Carnet = {
    connait: async (tenant, adresse) => {
      interroges.push([tenant, adresse]);
      return (o.carnets ?? { [A]: ["client@exemple.fr"] })[tenant]?.includes(adresse) ?? false;
    },
  };
  const garde = (tenant = o.tenant ?? A, executionId = "exec-1") => {
    const proprietaire: ProprietaireJeton = { clientDuJeton: async () => ("jeton" in o ? o.jeton : tenant) };
    return garderConnecteurs(connecteur, {
      valkey,
      tenantId: tenant,
      instanceId: "inst-1",
      executionId,
      annulable: false,
      ...(o.sansJeton ? {} : { proprietaireJeton: proprietaire }),
      ...(o.sansCarnet ? {} : { carnet }),
    });
  };
  let n = 0;
  const envoyer = (destinataire: unknown = "client@exemple.fr", g = garde()) =>
    g.appeler("envoyer", { cle: `cle-${++n}`, element: "msg", entree: { destinataire, objet: "x", corps: "y" }, signal: new AbortController().signal });
  return { valkey, connecteur, interroges, garde, envoyer };
}

describe("garde d'envoi : isolation entre clients", () => {
  it("[C-534] @isolation un jeton du client B donné à une instance du client A est refusé par la garde (jeton_autre_client, 0 appel)", async () => {
    const b = banc({ jeton: B });
    await expect(b.envoyer()).rejects.toMatchObject({ classe: "definitive", code: "jeton_autre_client" });
    expect(b.connecteur.appels).toHaveLength(0);
  });

  it("[C-534] @isolation un travail forgé (clientId B, configuration du client A) est refusé avant toute écriture de la boîte ou du journal", async () => {
    const moteur = new FauxMoteur();
    const horloge = new HorlogeFactice();
    const connecteur = new ConnecteurFactice();
    class ConsoleA extends ConsoleFactice {
      override async lireConfiguration(instanceId: string) {
        return { ...(await super.lireConfiguration(instanceId)), clientId: A };
      }
    }
    const module = defineAutomation({ ...manifesteExemple, etapes: [{ nom: "e1", executer: async (ctx) => void (await ctx.effet("envoyer", "msg-1", {})) }], connecteurs: [{ famille: "messagerie", actions: ["envoyer"], portees: ["envoi"], garantie: "verifiable_apres_coup" }] });
    let appelsGarde = 0;
    const executer = executerAvecMoteur({
      pool: moteur.pool(), module, console: new ConsoleA({ reglages: { actionsAutomatiquesAutorisees: ["envoyer"], objetAccuse: "x" } }), connecteurs: connecteur, horloge,
      garderEnvois: (c) => { appelsGarde++; return c; },
    });
    const forge: Travail = { id: randomUUID(), instanceId: "inst-1", clientId: B, palier: "pro" };
    moteur.ouvrirExecution("inst-1", forge.id);
    await expect(executer(forge)).rejects.toMatchObject({ classe: "definitive", code: "client_incoherent" });
    expect(moteur.requetes).toEqual([]);
    expect(appelsGarde).toBe(0);
    expect(connecteur.appels).toHaveLength(0);
  });

  it("[C-534] @isolation un destinataire connu seulement du client B est refusé chez A (destinataire_hors_client, 0 appel)", async () => {
    const b = banc({ carnets: { [A]: ["client@exemple.fr"], [B]: ["marie@exemple.fr"] } });
    await expect(b.envoyer("marie@exemple.fr")).rejects.toMatchObject({ classe: "definitive", code: "destinataire_hors_client" });
    expect(b.connecteur.appels).toHaveLength(0);
    expect(b.interroges).toEqual([[A, "marie@exemple.fr"]]);
  });

  it("[C-534] @isolation la forme canonique ne contourne pas le carnet (majuscules, « + » gardé, domaine IDN en punycode, nom affiché, deux @, espaces)", async () => {
    expect(adresseCanonique("  Marie+Devis@CAFÉ.Exemple.fr ")).toBe("marie+devis@xn--caf-dma.exemple.fr");
    const b = banc({ carnets: { [A]: ["marie+devis@xn--caf-dma.exemple.fr"] } });
    await b.envoyer("  Marie+Devis@CAFÉ.Exemple.fr ");
    expect(b.connecteur.appels).toHaveLength(1);
    await expect(b.envoyer("marie@café.exemple.fr")).rejects.toMatchObject({ code: "destinataire_hors_client" }); // sans le « + » : autre adresse
    for (const mauvais of ["Marie <marie+devis@exemple.fr>", "<marie@exemple.fr>", "a@b@exemple.fr", "marie devis@exemple.fr", '"x"@exemple.fr', "sans-arobase", "", 42, undefined]) {
      await expect(b.envoyer(mauvais)).rejects.toMatchObject({ classe: "definitive", code: "destinataire_illisible" });
    }
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[C-534] @envoi sans port Carnet ou ProprietaireJeton, tout envoi est refusé", async () => {
    for (const reglage of [{ sansCarnet: true }, { sansJeton: true }]) {
      const b = banc(reglage);
      await expect(b.envoyer()).rejects.toMatchObject({ classe: "definitive", code: "garde_non_configuree" });
      expect(b.connecteur.appels).toHaveLength(0);
    }
  });
});

describe("garde d'envoi : arrêt d'urgence lu à chaque envoi", () => {
  it("[C-534] @envoi arrêt global posé : envoi refusé (arret_urgence), 0 appel", async () => {
    const b = banc();
    b.valkey.cles.set(CLE_ARRET_GLOBAL, "1");
    const e = await b.envoyer().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ArretEnvoisPose);
    expect(e).toMatchObject({ classe: "passagere", code: "arret_urgence" });
    expect(b.connecteur.appels).toHaveLength(0);
  });

  it("[C-534] @envoi l'arrêt du client A n'arrête pas les envois du client B", async () => {
    const b = banc({ carnets: { [A]: ["client@exemple.fr"], [B]: ["client@exemple.fr"] } });
    b.valkey.cles.set(cleArretClient(A), "1");
    await expect(b.envoyer("client@exemple.fr", b.garde(A))).rejects.toMatchObject({ code: "arret_urgence" });
    expect(b.connecteur.appels).toHaveLength(0);
    await b.envoyer("client@exemple.fr", b.garde(B));
    expect(b.connecteur.appels).toHaveLength(1);
  });

  it("[C-534] @envoi Valkey injoignable au moment de la garde : envoi refusé, jamais passé", async () => {
    const b = banc();
    b.valkey.injoignable = true;
    await expect(b.envoyer()).rejects.toMatchObject({ classe: "passagere", code: "garde_indisponible" });
    expect(b.connecteur.appels).toHaveLength(0);
  });

  it("[C-534] @envoi Valkey qui ne répond pas dans le délai de la garde : envoi refusé", async () => {
    const b = banc();
    b.valkey.mget = () => new Promise(() => undefined);
    const g = garderConnecteurs(b.connecteur, { valkey: b.valkey, tenantId: A, instanceId: "inst-1", executionId: "exec-1", annulable: false, delaiLectureMs: 20, proprietaireJeton: { clientDuJeton: async () => A }, carnet: { connait: async () => true } });
    await expect(b.envoyer("client@exemple.fr", g)).rejects.toMatchObject({ classe: "passagere", code: "garde_indisponible" });
    expect(b.connecteur.appels).toHaveLength(0);
  });

  it("[C-534] @envoi l'arrêt est relu à chaque envoi : 2e envoi de la même exécution refusé après la pose", async () => {
    const b = banc();
    const g = b.garde();
    await b.envoyer("client@exemple.fr", g);
    b.valkey.cles.set(cleArretClient(A), "1");
    await expect(b.envoyer("client@exemple.fr", g)).rejects.toMatchObject({ code: "arret_urgence" });
    expect(b.connecteur.appels).toHaveLength(1);
    expect(b.valkey.lectures).toBe(2);
  });

  it("[C-534] les actions hors envoi (lire, etiqueter, creer_brouillon) ne sont pas bloquées par l'arrêt", async () => {
    const b = banc();
    b.valkey.cles.set(CLE_ARRET_GLOBAL, "1");
    const g = b.garde();
    for (const action of ["lire", "etiqueter", "creer_brouillon"]) await g.appeler(action, { cle: `c-${action}`, element: "m", entree: {}, signal: new AbortController().signal });
    expect(b.connecteur.appels.map((a) => a.action)).toEqual(["lire", "etiqueter", "creer_brouillon"]);
  });

  it("[C-534] @isolation un identifiant de client qui n'est pas un UUID (« : », « * », espace) ne construit aucune clé", async () => {
    expect(() => cleArretClient("a:b")).toThrow();
    expect(() => cleArretClient("*")).toThrow();
    expect(() => cleArretClient(`${A} `)).toThrow();
    expect(cleArretClient(A)).toBe(`executeur:arret:client:${A}`);
  });
});
