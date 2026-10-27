import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scannerTexte } from "../../../../scripts/scanner-journaux.js";
import { construireServeur } from "../serveur.js";
import { cheminSansRequete, retirerRequetes } from "./serialiseur-req.js";

const jetonDeTest = () => `TEST-NE-PAS-UTILISER-jeton-${randomBytes(8).toString("hex")}`;

function serveurAvecLignes() {
  const lignes: string[] = [];
  const serveur = construireServeur({ journal: { write: (l) => void lignes.push(l) } });
  return { serveur, lignes };
}

describe("journal de l'API : l'adresse sans paramètres", () => {
  it("[C-531] @isolation une requête GET /x?code=SECRET-FICTIF écrit /x sans le paramètre", async () => {
    const { serveur, lignes } = serveurAvecLignes();
    serveur.get("/x", async () => ({ ok: true }));
    const jeton = jetonDeTest();
    await serveur.inject({ method: "GET", url: `/x?code=${jeton}&state=SECRET-FICTIF` });
    await serveur.close();
    const sortie = lignes.join("");
    expect(sortie, "témoin : la requête est journalisée").toContain('"url":"/x"');
    expect(sortie.includes(jeton) || sortie.includes("SECRET-FICTIF") || sortie.includes("code=")).toBe(false);
    expect(scannerTexte("journal", sortie)).toEqual([]);
  });

  it("[A-346] le chemin, la méthode et le code de réponse restent dans le journal", async () => {
    const { serveur, lignes } = serveurAvecLignes();
    serveur.get("/clients/essai", async () => ({ ok: true }));
    await serveur.inject({ method: "GET", url: "/clients/essai?a=1" });
    await serveur.close();
    const objets = lignes.map((l) => JSON.parse(l) as Record<string, unknown>);
    const entree = objets.find((o) => o.req !== undefined);
    const fin = objets.find((o) => o.res !== undefined);
    expect(entree?.req).toEqual({ method: "GET", url: "/clients/essai" });
    expect(fin?.res).toEqual({ statusCode: 200 });
    expect(typeof fin?.responseTime).toBe("number");
    expect(typeof entree?.reqId).toBe("string");
    expect(fin?.reqId).toBe(entree?.reqId);
  });

  it("[C-531] @isolation l'adresse avec fragment et l'adresse sans paramètre sont traitées", () => {
    expect(cheminSansRequete("/a/b?code=1")).toBe("/a/b");
    expect(cheminSansRequete("/a/b#frag=1")).toBe("/a/b");
    expect(cheminSansRequete("/a/b?x=1#y")).toBe("/a/b");
    expect(cheminSansRequete("/a/b")).toBe("/a/b");
    expect(cheminSansRequete("/?")).toBe("/");
    expect(cheminSansRequete(undefined)).toBe("");
    expect(retirerRequetes("échec sur /connexion/retour?code=abc&state=x")).toBe("échec sur /connexion/retour");
    expect(retirerRequetes("échec sur https://exemple.test/p?code=abc#f fin")).toBe("échec sur https://exemple.test/p fin");
    expect(retirerRequetes("rien à retirer sur /p/q")).toBe("rien à retirer sur /p/q");
  });

  it("[A-103] une erreur levée pendant le traitement d'un lien signé ne remet pas le jeton dans le journal", async () => {
    const { serveur, lignes } = serveurAvecLignes();
    serveur.get("/lien", async (requete) => {
      throw new Error(`échec sur ${requete.url}`);
    });
    const jeton = jetonDeTest();
    const r = await serveur.inject({ method: "GET", url: `/lien?code=${jeton}` });
    await serveur.close();
    expect(r.statusCode).toBe(500);
    const sortie = lignes.join("");
    expect(sortie, "témoin : l'erreur est journalisée").toContain("erreur interne");
    expect(sortie.includes(jeton)).toBe(false);
    expect(scannerTexte("journal", sortie)).toEqual([]);
  });

  it("[C-531] une redirection dont Location porte ?code= et une requête avec Referer ne mettent pas le jeton au journal", async () => {
    const { serveur, lignes } = serveurAvecLignes();
    const jeton = jetonDeTest();
    serveur.get("/vers", async (_requete, reponse) => reponse.redirect(`/ailleurs?code=${jeton}`));
    const r = await serveur.inject({ method: "GET", url: "/vers", headers: { referer: `https://exemple.test/avant?code=${jeton}` } });
    await serveur.close();
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toContain(jeton);
    const sortie = lignes.join("");
    expect(sortie, "témoin : la requête est journalisée").toContain('"url":"/vers"');
    expect(sortie.includes(jeton)).toBe(false);
  });

  it("[C-531] le journal ne garde ni l'adresse IP ni le port du client", async () => {
    const { serveur, lignes } = serveurAvecLignes();
    serveur.get("/x", async () => ({ ok: true }));
    await serveur.inject({ method: "GET", url: "/x", remoteAddress: "198.51.100.7", headers: { host: "interne.exemple.test" } });
    await serveur.close();
    const sortie = lignes.join("");
    expect(sortie, "témoin : la requête est journalisée").toContain('"url":"/x"');
    expect(sortie).not.toMatch(/198\.51\.100\.7|interne\.exemple\.test|remoteAddress|remotePort|hostname|"host"/);
  });
});
