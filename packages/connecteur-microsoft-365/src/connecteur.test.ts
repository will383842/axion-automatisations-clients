import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErreurConnecteur, creerJeton } from "@axion-auto/connecteurs-commun";
import { lancer } from "@axion-auto/connecteurs-commun/src/suite/lanceur.ts";
import type { Banc, Fabrique, Scenario } from "@axion-auto/connecteurs-commun/src/suite/messagerie.ts";
import { creerConnecteurMicrosoft365, ouvrirMicrosoft365 } from "./connecteur.ts";

const BASE = "http://graph.test/v1.0";
const MAINTENANT = Date.parse("2026-10-26T08:00:00Z");

type Echange = { methode: string; chemin: string; statut?: number; entetes?: Record<string, string>; corps?: unknown; reseau?: boolean };

// Rejoue les réponses enregistrées dans l'ordre : un appel hors ordre ou en trop échoue.
export function fetchRejoue(echanges: Echange[], vus: { methode: string; url: string; corps: string | undefined }[] = []): typeof fetch {
  const file = [...echanges];
  return (async (url: string, init: RequestInit = {}) => {
    const methode = init.method ?? "GET";
    vus.push({ methode, url, corps: init.body as string | undefined });
    const e = file.shift();
    if (!e || e.methode !== methode || !url.startsWith(`${BASE}${e.chemin}`)) throw new Error(`appel hors enregistrement : ${methode} ${url}`);
    if (e.reseau) throw new TypeError("fetch failed");
    return new Response(e.corps === undefined ? null : JSON.stringify(e.corps), { status: e.statut ?? 200, headers: e.entetes ?? {} });
  }) as never;
}

const fabriqueEnregistree: Fabrique = (s: Scenario): Banc => {
  const chemin = fileURLToPath(new URL(`../enregistrements/${s.nom}.json`, import.meta.url));
  const { echanges } = JSON.parse(readFileSync(chemin, "utf8")) as { echanges: Echange[] };
  const vus: { methode: string; url: string; corps: string | undefined }[] = [];
  const valeurJeton = `jeton-fictif-${s.nom}`;
  const connecteur = creerConnecteurMicrosoft365({ url: BASE, fetch: fetchRejoue(echanges, vus), maintenant: () => MAINTENANT });
  return { connecteur, jeton: creerJeton(valeurJeton, MAINTENANT + 60_000), valeurJeton, envoyes: () => vus.filter((v) => v.url.endsWith("/send")).length };
};

describe("connecteur Microsoft 365 sur réponses enregistrées", () => {
  it("[A-405] le connecteur Microsoft 365 passe la suite messagerie sur enregistrements", async () => {
    const reseau = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("réseau interdit"); }) as never;
    try {
      await lancer(fabriqueEnregistree);
    } finally {
      globalThis.fetch = reseau;
    }
  });

  it("[A-405] l'envoi pose le Message-ID et l'en-tête d'intention à la création du brouillon", async () => {
    const vus: { methode: string; url: string; corps: string | undefined }[] = [];
    const c = creerConnecteurMicrosoft365({
      url: BASE, maintenant: () => MAINTENANT,
      fetch: fetchRejoue([
        { methode: "POST", chemin: "/me/messages", statut: 201, corps: { id: "b-1", internetMessageId: "<m-1.essai@exemple.fr>" } },
        { methode: "POST", chemin: "/me/messages/b-1/send", statut: 202 },
      ], vus),
    });
    await c.envoyer(creerJeton("jeton-fictif", MAINTENANT + 60_000), { messageId: "<m-1.essai@exemple.fr>", destinataire: "client@exemple.fr", objet: "Essai", corps: "Bonjour" });
    const brouillon = JSON.parse(vus[0]?.corps ?? "{}");
    expect(brouillon.internetMessageId).toBe("<m-1.essai@exemple.fr>");
    expect(brouillon.internetMessageHeaders).toEqual([{ name: "X-Axion-Intention", value: "<m-1.essai@exemple.fr>" }]);
  });

  it("[A-405] le curseur est le deltaLink rendu par Graph, et un curseur d'une autre adresse est refusé", async () => {
    const delta = `${BASE}/me/mailFolders/inbox/messages/delta?$deltatoken=d1`;
    const c = creerConnecteurMicrosoft365({
      url: BASE, maintenant: () => MAINTENANT,
      fetch: fetchRejoue([{ methode: "GET", chemin: "/me/mailFolders/inbox/messages/delta", corps: { value: [{ id: "m-1" }], "@odata.deltaLink": delta } }]),
    });
    const jeton = creerJeton("jeton-fictif", MAINTENANT + 60_000);
    expect(await c.listerNouveaux(jeton, null)).toEqual({ ids: ["m-1"], suivant: null });
    expect(c.curseurDelta()).toBe(delta);
    const e = await c.listerNouveaux(jeton, "http://autre.test/v1.0/delta?x=1").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurConnecteur);
    expect((e as ErreurConnecteur).code).toBe("curseur_invalide");
  });

  it("[A-405] le connecteur reste fermé sans l'interrupteur et lit GRAPH_URL à l'ouverture", () => {
    expect(() => ouvrirMicrosoft365({})).toThrow(/fermé/);
    const c = ouvrirMicrosoft365({ CONNECTEURS_MESSAGERIE_OUVERT: "1", GRAPH_URL: BASE });
    expect(c.declaration.capacites.find((x) => x.action === "envoyer")?.garantie).toBe("verifiable_apres_coup");
  });

  it("[A-406] aucun corps de message dans les journaux du connecteur (marqueur unique)", async () => {
    const MARQUEUR = "CORPS-UNIQUE-7f3a91";
    const lignes: string[] = [];
    const c = creerConnecteurMicrosoft365({
      url: BASE, maintenant: () => MAINTENANT, journal: (l) => lignes.push(l),
      fetch: fetchRejoue([
        { methode: "POST", chemin: "/me/messages", statut: 201, corps: { id: "b-1", internetMessageId: "<m-2.essai@exemple.fr>" } },
        { methode: "POST", chemin: "/me/messages/b-1/send", statut: 400, corps: { error: { code: "ErrorInvalidRecipients", message: MARQUEUR } } },
        { methode: "GET", chemin: "/me/messages/m-1", corps: { id: "m-1", body: { content: MARQUEUR } } },
      ]),
    });
    const jeton = creerJeton("jeton-fictif", MAINTENANT + 60_000);
    await c.envoyer(jeton, { messageId: "<m-2.essai@exemple.fr>", destinataire: "client@exemple.fr", objet: "Essai", corps: MARQUEUR }).catch(() => undefined);
    await c.lire(jeton, "m-1", ["corps"]);
    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.join("\n")).not.toContain(MARQUEUR);
  });
});
