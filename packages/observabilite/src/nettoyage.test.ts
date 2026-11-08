import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { avantEnvoi, type EvenementNettoye } from "./nettoyage.ts";

// Les secrets sont générés dans le test : rien de versionné ne ressemble à une vraie clé.
const secret = () => `marqueur-${randomUUID()}`;
const jetonOpaque = () => randomUUID().replaceAll("-", "").slice(0, 24);
const nettoyer = (brut: unknown, extra: { masquerSecrets?: (t: string) => string } = {}): EvenementNettoye =>
  avantEnvoi(brut, { application: "api", ...extra });
const routeDe = (url: string) => nettoyer({ request: { url } }).tags.route;
const messageDe = (message: string) => JSON.stringify(nettoyer({ message }));

describe("observabilite : nettoyage complet (solde des dettes de 13a)", () => {
  it("[C-025] une chaîne de connexion avec mot de passe, un en-tête Basic et « password=… » sont masqués dans le message", () => {
    const mdp = secret();
    const basic = Buffer.from(`utilisateur:${mdp}`).toString("base64");
    const ouvert = `s.${jetonOpaque()}`;
    const hvs = `hvs.${jetonOpaque()}`;
    const sortie = messageDe(`échec postgres://app:${mdp}@base-interne:5432/prod ; Authorization: Basic ${basic} ; password=${mdp} ; secret=${mdp} ; ${ouvert} ; ${hvs}`);
    for (const interdit of [mdp, basic, ouvert, hvs]) expect(sortie).not.toContain(interdit);
    expect(sortie).toContain("[masqué]");
  });

  it("[C-025] un IBAN en minuscules et un numéro « +33 (0)6 » sont masqués", () => {
    const sortie = messageDe("virement fr7630006000011234567890189 puis appel +33 (0)6 12 34 56 78");
    expect(sortie).not.toContain("fr7630006000011234567890189");
    expect(sortie).not.toContain("12 34 56 78");
  });

  it("[C-025] le segment qui tient la place d'un paramètre déclaré (:jeton) est masqué quelle que soit sa forme", () => {
    const jeton = "ZxyQabcDEFghijKLMnopQRst";
    expect(routeDe(`/reinit/${jeton}`)).toBe("/reinit/:id");
    expect(routeDe(`/a;jeton=${jeton}/b`)).toBe("/:id/b");
    expect(routeDe(`/invitations/abcdefghij`)).toBe("/invitations/:id");
    expect(routeDe(`/fin/accuse/lisible/encore`)).toBe("/fin/accuse/:id/:id");
    expect(routeDe("/api/console/v1/clients/envois")).toBe("/api/console/v1/clients/envois");
  });

  it("[C-025] un segment contenant @ est masqué", () => {
    expect(routeDe("/api/contacts/claire@exemple.fr/notes")).toBe("/api/contacts/:id/notes");
    expect(routeDe("/api/contacts/x@y/notes")).toBe("/api/contacts/:id/notes");
  });

  it("[A-113] l'événement nettoyé garde la forme Sentry : exception.values[0].type et étiquettes application, cellule, route", () => {
    const ev = nettoyer({
      exception: { values: [{ type: "ErreurConnecteur", value: "échec" }] },
      request: { url: "https://auto.exemple.fr/api/console/v1/envois?x=1" },
      contexts: { app: { cellule: "cellule-1", instance: "inst-42" } },
      release: "1.4.2",
    });
    expect(ev.exception.values[0]?.type).toBe("ErreurConnecteur");
    expect(ev.tags).toEqual({ application: "api", cellule: "cellule-1", route: "/api/console/v1/envois" });
    expect(ev.release).toBe("1.4.2");
    expect(ev.contexts.app.instance).toBe("inst-42");
  });

  it("[C-025] les cadres de pile ne gardent ni variables locales, ni lignes de source, ni chemin absolu", () => {
    const mdp = secret();
    const ev = nettoyer({
      exception: { values: [{ type: "E", value: "x", stacktrace: { frames: [{
        filename: "/home/utilisateur/projet/src/connecteur.ts", abs_path: "/home/utilisateur/projet/src/connecteur.ts",
        function: "lire", lineno: 12, vars: { jeton: mdp }, context_line: `const cle = "${mdp}"`, pre_context: [mdp], post_context: [mdp],
      }] } }] },
    });
    const sortie = JSON.stringify(ev);
    expect(sortie).not.toContain(mdp);
    expect(sortie).not.toContain("/home/");
    expect(sortie).not.toMatch(/vars|context_line|pre_context|post_context|abs_path/);
    expect(ev.exception.values[0]?.stacktrace?.frames[0]).toEqual({ filename: "connecteur.ts", function: "lire", lineno: 12 });
  });

  it("[C-025] user, request, extra, breadcrumbs, server_name, modules et contexts hors app sont retirés", () => {
    const mdp = secret();
    const ev = nettoyer({
      message: "m", user: { id: mdp }, request: { data: mdp, url: "/x" }, extra: { a: mdp }, breadcrumbs: { values: [mdp] },
      server_name: "hote-interne", modules: { a: "1" }, contexts: { os: { name: mdp }, runtime: { name: mdp }, app: { cellule: "c1" } },
    });
    const sortie = JSON.stringify(ev);
    expect(sortie).not.toContain(mdp);
    expect(sortie).not.toContain("hote-interne");
    for (const cle of ["user", "request", "extra", "breadcrumbs", "server_name", "modules"]) expect(ev).not.toHaveProperty(cle);
    expect(Object.keys(ev.contexts)).toEqual(["app"]);
  });

  it("[C-025] un message contenant un identifiant de forme inconnue reste borné à la liste fermée de champs", () => {
    // Limite écrite : le masquage par motifs n'est pas exhaustif ; la liste fermée de champs et la borne de taille sont le rempart.
    const ev = nettoyer({ message: `dossier ZZ-${"x".repeat(900)}` });
    expect(ev.message.length).toBeLessThanOrEqual(500);
    expect(Object.keys(ev).sort()).toEqual(["contexts", "exception", "message", "release", "tags"]);
  });

  it("[C-025] un champ inattendu à la racine de l'événement n'est jamais recopié", () => {
    const mdp = secret();
    const ev = nettoyer({ message: "m", champ_surprise: mdp, fingerprint: [mdp], sdk: { name: mdp }, transaction: mdp, tags: { autre: mdp } });
    const sortie = JSON.stringify(ev);
    expect(sortie).not.toContain(mdp);
    expect(ev.tags).not.toHaveProperty("autre");
  });

  it("[LOT5-secret] une valeur inscrite au masqueur injecté est absente de l'événement, même en base64", () => {
    const mdp = secret();
    const b64 = Buffer.from(mdp).toString("base64");
    const masquerSecrets = (t: string) => t.replaceAll(mdp, "[masqué]").replaceAll(b64, "[masqué]");
    const ev = nettoyer({ message: `a ${mdp} b ${b64}`, exception: { values: [{ type: "E", value: `c ${mdp} ${b64}` }] } }, { masquerSecrets });
    const sortie = JSON.stringify(ev);
    expect(sortie).not.toContain(mdp);
    expect(sortie).not.toContain(b64);
  });
});

describe("observabilite : dettes de la PR 13b-1 reportées en 13b-2", () => {
  it("[LOT5-secret] le masqueur injecté passe avant les motifs : un secret que les motifs couperaient en deux est masqué en entier", () => {
    // Un secret qui contient un espace : le motif « s.… » en prendrait la première moitié et laisserait la suite en clair.
    const suite = randomUUID();
    const mdp = `s.${jetonOpaque()} suite-${suite}`;
    const masquerSecrets = (t: string) => t.replaceAll(mdp, "[masqué]");
    const sortie = JSON.stringify(nettoyer({ message: `échec ${mdp}`, exception: { values: [{ type: "E", value: `échec ${mdp}` }] } }, { masquerSecrets }));
    expect(sortie).not.toContain(suite);
  });

  it("[C-025] une adresse illisible est coupée au premier ? ou # avant tout découpage en segments", () => {
    const jeton = jetonOpaque();
    expect(routeDe(`http://[illisible/api/x?jeton=${jeton}`)).toBe("http://[illisible/api/x");
    expect(routeDe(`http://[illisible/api/x#${jeton}`)).toBe("http://[illisible/api/x");
    expect(routeDe(`/api/x?a=/reinit/${jeton}#f`)).toBe("/api/x");
  });
});
