import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineAutomation } from "../../../packages/sdk-module/src/index.ts";
import { manifesteExemple } from "../../../packages/sdk-module/exemples/module-exemple.ts";
import { creerJeton, ErreurConnecteur as ErreurCommune } from "../../../packages/connecteurs-commun/src/index.ts";
import { creerConnecteurMicrosoft365 } from "../../../packages/connecteur-microsoft-365/src/connecteur.ts";
import { demarrerFauxGraph, type FauxGraph } from "../../../packages/harnais/src/faux-graph/serveur.ts";
import { creerClientMailpit } from "../../../packages/harnais/src/mailpit.ts";
import { CLE_ARRET_GLOBAL } from "../../../apps/executeur/src/envois/arret-urgence.ts";
import { garderConnecteurs } from "../../../apps/executeur/src/envois/garde-envoi.ts";
import { executerAvecMoteur, type Travail } from "../../../apps/executeur/src/files/travailleur.ts";
import { HorlogeSysteme } from "../../../apps/executeur/src/noyau/horloge.ts";
import { ConsoleFactice } from "../../../apps/executeur/src/noyau/memoire/console-factice.ts";
import { FauxMoteur } from "../../../apps/executeur/src/noyau/postgres/faux-moteur.ts";
import { ErreurConnecteur } from "../../../apps/executeur/src/noyau/politique-erreurs.ts";
import type { Connecteurs } from "../../../apps/executeur/src/noyau/ports.ts";

// Scénario « message envoyé par erreur » (C-534) : faux Graph réel, connecteur Microsoft 365 réel, puits SMTP en mémoire à la place de Mailpit
// (le socle d'intégration n'a pas Mailpit), garde d'envoi branchée dans executerAvecMoteur. Les 4 tests @lot-4 de s8 restent en .fails (dette T4-46).
const CLIENT = randomUUID();
const INSTANCE = "inst-1";
const COMPTE = "faux.lemoine@exemple.fr";

type Depot = { de: string; pour: string[]; donnees: string };
async function demarrerPuitsSmtp(): Promise<{ port: number; depots: Depot[]; arreter(): Promise<void> }> {
  const depots: Depot[] = [];
  const serveur: Server = createServer((socket) => {
    let depot: Depot = { de: "", pour: [], donnees: "" };
    let tampon = "";
    let enDonnees = false;
    socket.write("220 puits.test ESMTP\r\n");
    socket.on("data", (morceau) => {
      tampon += morceau.toString("utf8");
      for (;;) {
        if (enDonnees) {
          const fin = tampon.indexOf("\r\n.\r\n");
          if (fin < 0) return;
          depot.donnees = tampon.slice(0, fin);
          tampon = tampon.slice(fin + 5);
          depots.push(depot);
          depot = { de: "", pour: [], donnees: "" };
          enDonnees = false;
          socket.write("250 ok\r\n");
          continue;
        }
        const saut = tampon.indexOf("\r\n");
        if (saut < 0) return;
        const ligne = tampon.slice(0, saut);
        tampon = tampon.slice(saut + 2);
        const commande = ligne.slice(0, 4).toUpperCase();
        if (commande === "EHLO" || commande === "HELO") socket.write("250 puits.test\r\n");
        else if (commande === "QUIT") socket.end("221 bye\r\n");
        else if (commande === "DATA") {
          enDonnees = true;
          socket.write("354 go\r\n");
        } else {
          const adresse = ligne.slice(ligne.indexOf("<") + 1, ligne.indexOf(">"));
          if (commande === "MAIL") depot.de = adresse;
          if (commande === "RCPT") depot.pour.push(adresse);
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  return { port: (serveur.address() as { port: number }).port, depots, arreter: () => new Promise<void>((ok) => serveur.close(() => ok())) };
}

class FauxValkey {
  cles = new Map<string, string>();
  async mget(...cles: string[]) {
    return cles.map((c) => this.cles.get(c) ?? null);
  }
  async call(_c: string, cle = "", valeur = "", ...options: string[]): Promise<unknown> {
    const ancien = this.cles.get(cle) ?? null;
    if (options.includes("NX") && ancien !== null) return options.includes("GET") ? ancien : null;
    this.cles.set(cle, valeur);
    return options.includes("GET") ? ancien : "OK";
  }
}
class ConsoleClient extends ConsoleFactice {
  override async lireConfiguration(instanceId: string) {
    return { ...(await super.lireConfiguration(instanceId)), clientId: CLIENT };
  }
}

let puits: Awaited<ReturnType<typeof demarrerPuitsSmtp>>;
let graph: FauxGraph;
beforeAll(async () => {
  puits = await demarrerPuitsSmtp();
  graph = await demarrerFauxGraph({ mailpit: creerClientMailpit({ api: "http://127.0.0.1:1", smtpHote: "127.0.0.1", smtpPort: puits.port }) });
});
afterAll(async () => void (await Promise.all([graph.arreter(), puits.arreter()])));
const controle = (mode: string) => fetch(`${graph.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, reinitialiser: mode === "normal" }) });
beforeEach(async () => {
  puits.depots.length = 0;
  await controle("normal");
});

// Adaptateur Connecteurs → connecteur Microsoft 365 : il vit dans le test, pas dans le code produit.
function banc() {
  const connecteurM365 = creerConnecteurMicrosoft365({ url: `${graph.url}/v1.0` });
  const jeton = creerJeton(COMPTE, Date.now() + 3_600_000);
  const convertir = (e: unknown) => (e instanceof ErreurCommune ? new ErreurConnecteur(e.classe, e.code) : e);
  const idDe = (cle: string) => `<${cle}@exemple.test>`;
  const connecteurs: Connecteurs = {
    async appeler(_action, d) {
      const { destinataire, objet, corps } = d.entree as { destinataire: string; objet: string; corps: string };
      try {
        await connecteurM365.envoyer(jeton, { messageId: idDe(d.cle), destinataire, objet, corps });
      } catch (e) {
        throw convertir(e);
      }
      return { ok: true };
    },
    async verifier(_action, cle) {
      const v = await connecteurM365.verifierApresCoup(jeton, idDe(cle));
      return v === "trouve" ? "trouvee" : v === "absent" ? "absente" : "inconnue";
    },
  };
  const module = defineAutomation({
    ...manifesteExemple,
    etapes: [{ nom: "e1", executer: async (ctx) => void (await ctx.effet("envoyer", "msg-1", { destinataire: "client@exemple.fr", objet: "Devis", corps: "Bonjour" })) }],
    connecteurs: [{ famille: "messagerie", actions: ["envoyer"], portees: ["envoi"], garantie: "verifiable_apres_coup" }],
  });
  const moteur = new FauxMoteur();
  const horloge = new HorlogeSysteme();
  const valkey = new FauxValkey();
  const console = new ConsoleClient({ reglages: { actionsAutomatiquesAutorisees: ["envoyer"], objetAccuse: "x" } });
  const executer = executerAvecMoteur({
    pool: moteur.pool(), module, console, connecteurs, horloge,
    garderEnvois: (c, ctx) => garderConnecteurs(c, { valkey, tenantId: ctx.clientId, instanceId: ctx.travail.instanceId, executionId: ctx.travail.id, annulable: false, proprietaireJeton: { clientDuJeton: async () => CLIENT }, carnet: { connait: async (t, a) => t === CLIENT && a === "client@exemple.fr" } }),
  });
  const travail: Travail = { id: randomUUID(), instanceId: INSTANCE, clientId: CLIENT, palier: "pro" };
  moteur.ouvrirExecution(INSTANCE, travail.id);
  return { moteur, horloge, valkey, executer, travail };
}

describe("message envoyé par erreur : faux Graph, connecteur Microsoft 365 et puits SMTP", () => {
  it("[C-534] @anti-doublon coupure après l'envoi, avant le journal (reponse_perdue) : exactement 1 message dans le puits après reprise", async () => {
    const b = banc();
    await controle("reponse_perdue");
    await expect(b.executer(b.travail)).rejects.toMatchObject({ classe: "passagere", code: "reponse_perdue" });
    expect(puits.depots).toHaveLength(1);
    await controle("reponse_perdue"); // la recherche dans Éléments envoyés répond encore
    await b.executer(b.travail);
    expect(puits.depots).toHaveLength(1);
    expect(b.moteur.etat.intentions.map((i) => i.etat)).toEqual(["faite"]);
  });

  it("[C-534] @anti-doublon panne pendant la recherche : à trancher, 0 renvoi", async () => {
    const b = banc();
    await controle("reponse_perdue");
    await expect(b.executer(b.travail)).rejects.toMatchObject({ code: "reponse_perdue" });
    await controle("panne_generale"); // la recherche ne conclut pas
    await b.executer(b.travail);
    expect(puits.depots).toHaveLength(1);
    expect(b.moteur.etat.intentions.map((i) => i.etat)).toEqual(["a_trancher"]);
  });

  it("[C-534] @envoi arrêt global posé : 0 message dans le puits", async () => {
    const b = banc();
    b.valkey.cles.set(CLE_ARRET_GLOBAL, "1");
    await expect(b.executer(b.travail)).rejects.toMatchObject({ classe: "passagere", code: "arret_urgence" });
    expect(puits.depots).toHaveLength(0);
  });
});
