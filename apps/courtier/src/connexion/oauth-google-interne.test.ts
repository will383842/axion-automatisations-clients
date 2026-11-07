import { describe, expect, it } from "vitest";
import { adresseAutorisation, echanger, type ConfigGoogle } from "./oauth-google-interne.js";
import { creerTransactionsMemoire } from "./transactions.js";

const CFG: ConfigGoogle = { redirectUri: "https://portail.exemple.fr/connexion/retour", portees: ["https://mail.google.com/"] };
const SECRET_APP = "marqueur-secret-application-77aa";
const idToken = (p: object) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(p)).toString("base64url")}.sig`;
const tx = () => creerTransactionsMemoire({ maintenant: () => 1_800_000_000_000 }).creer({ sujet: "p", tenantId: "11111111-1111-4111-8111-111111111111", connexionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", outil: "gmail", fournisseur: "google", genre: "autorisation", domaine: "atelier-bertin.test" });
const reponse = (hd: string | undefined) => (async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, id_token: idToken({ sub: "s1", email: "x@atelier-bertin.test", ...(hd ? { hd } : {}) }) }), { status: 200 })) as typeof fetch;

describe("OAuth Google interne", () => {
  it("[B-092] Google interne : identifiant et secret de l'application lus par le port, jamais dans la réponse ni le journal ; domaine reçu différent : refus", async () => {
    const t = await tx();
    const u = new URL(adresseAutorisation(t, { client_id: "id-app-interne" }, CFG));
    expect(u.origin).toBe("https://accounts.google.com");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.toString()).not.toContain(SECRET_APP);
    const bon = await echanger(reponse("atelier-bertin.test"), t, "code", { client_id: "id-app-interne", client_secret: SECRET_APP }, CFG);
    expect(bon.compte.domaine).toBe("atelier-bertin.test");
    expect(JSON.stringify(bon)).not.toContain(SECRET_APP);
    for (const hd of ["autre.test", undefined]) {
      await expect(echanger(reponse(hd), t, "code", { client_id: "id-app-interne", client_secret: SECRET_APP }, CFG)).rejects.toMatchObject({ code: "mauvais_compte" });
    }
  });
});
