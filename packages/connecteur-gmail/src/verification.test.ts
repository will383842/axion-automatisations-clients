import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErreurConnecteur, creerJeton } from "@axion-auto/connecteurs-commun";
import { demarrerFauxGmail, type FauxGmail } from "../../harnais/src/faux-gmail/serveur.js";
import { creerConnecteurGmail } from "./connecteur.ts";

const MAINTENANT = Date.parse("2026-10-26T08:00:00Z");
const jeton = creerJeton("faux.lemoine@exemple.fr", MAINTENANT + 3_600_000);
let n = 0;
const message = () => ({ messageId: `<m-${++n}.verif@exemple.fr>`, destinataire: "client@exemple.fr", objet: "Devis", corps: "Bonjour" });

// Mini serveur SMTP local : le faux Gmail y dépose ses envois (aucun message ne sort).
function puitSmtp(): Promise<{ serveur: Server; port: number }> {
  const serveur = createServer((s) => {
    let donnees = false;
    s.write("220 puits.test ESMTP\r\n");
    s.on("data", (b) => {
      for (const ligne of b.toString().split("\r\n")) {
        if (donnees) { if (ligne === ".") { donnees = false; s.write("250 ok\r\n"); } continue; }
        if (/^(EHLO|HELO)/i.test(ligne)) s.write("250 puits.test\r\n");
        else if (/^DATA/i.test(ligne)) { donnees = true; s.write("354 go\r\n"); }
        else if (/^QUIT/i.test(ligne)) s.end("221 bye\r\n");
        else if (ligne) s.write("250 ok\r\n");
      }
    });
  });
  return new Promise((ok) => serveur.listen(0, "127.0.0.1", () => ok({ serveur, port: (serveur.address() as { port: number }).port })));
}

let gmail: FauxGmail;
let puits: Server;
beforeAll(async () => {
  const p = await puitSmtp();
  puits = p.serveur;
  gmail = await demarrerFauxGmail({ mailpit: { smtp: { host: "127.0.0.1", port: p.port } } as never });
});
afterAll(async () => {
  await gmail.arreter();
  puits.close();
});
const mode = (m: string, reinitialiser = false) =>
  fetch(`${gmail.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: m, reinitialiser }) });
const connecteur = () => creerConnecteurGmail({ url: gmail.url, maintenant: () => MAINTENANT });

describe("vérification après coup (Gmail n'a pas de clé anti-doublon)", () => {
  it("[A-386] @anti-doublon faux Gmail en reponse_perdue : verifierApresCoup trouve le message", async () => {
    await mode("reponse_perdue", true);
    const c = connecteur();
    const m = message();
    const e = await c.envoyer(jeton, m).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurConnecteur);
    expect([(e as ErreurConnecteur).classe, (e as ErreurConnecteur).code]).toEqual(["passagere", "reponse_perdue"]);
    expect(await c.verifierApresCoup(jeton, m.messageId)).toBe("trouve");
    expect(await c.verifierApresCoup(jeton, "<jamais-envoye@exemple.fr>")).toBe("absent");
  });

  it("[A-386] faux Gmail en acces_refuse : identification/application_bloquee_par_administrateur", async () => {
    await mode("acces_refuse", true);
    const e = (await connecteur().envoyer(jeton, message()).catch((x: unknown) => x)) as ErreurConnecteur;
    expect([e.classe, e.code]).toEqual(["identification", "application_bloquee_par_administrateur"]);
    await mode("normal", true);
  });

  it("[A-386] faux Gmail en quota : erreur quota datée par Retry-After", async () => {
    await mode("quota", true);
    const e = (await connecteur().envoyer(jeton, message()).catch((x: unknown) => x)) as ErreurConnecteur;
    expect([e.classe, e.details.reprise]).toEqual(["quota", "2026-10-26T08:00:02.000Z"]);
    await mode("normal", true);
  });

  it("[A-386] faux Gmail en panne pendant la vérification : indetermine, jamais absent", async () => {
    await mode("reponse_perdue", true);
    const c = connecteur();
    const m = message();
    await c.envoyer(jeton, m).catch(() => undefined);
    await mode("panne_generale");
    expect(await c.verifierApresCoup(jeton, m.messageId)).toBe("indetermine");
    await mode("normal", true);
  });

  it("[A-386] Gmail muet ou coupé pendant la vérification : indetermine au délai maximal, jamais absent", async () => {
    const muet = ((_url: string, init: RequestInit = {}) => new Promise((_ok, ko) => init.signal?.addEventListener("abort", () => ko(init.signal?.reason)))) as never;
    const c = creerConnecteurGmail({ url: "http://gmail.test", fetch: muet, delaiMs: 20, maintenant: () => MAINTENANT });
    expect(await c.verifierApresCoup(jeton, "<muet@exemple.fr>")).toBe("indetermine");
    const coupe = creerConnecteurGmail({ url: "http://gmail.test", fetch: (() => { throw new TypeError("fetch failed"); }) as never, maintenant: () => MAINTENANT });
    expect(await coupe.verifierApresCoup(jeton, "<coupe@exemple.fr>")).toBe("indetermine");
  });
});
