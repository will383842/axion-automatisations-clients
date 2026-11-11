import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adresseAutorisation, adresseAccordAdmin, echanger, type ConfigMicrosoft } from "./oauth-microsoft.js";
import { creerTransactionsMemoire } from "./transactions.js";

const LOC = "22222222-2222-4222-8222-222222222222";
const CFG: ConfigMicrosoft = { clientId: "app-axion@exemple.fr", redirectUri: "https://portail.exemple.fr/connexion/retour", portees: ["Mail.ReadWrite", "Mail.Send"], secretApplication: async () => "secret-fictif-pour-test" };
const nouvelle = (locataire: string) => creerTransactionsMemoire({ maintenant: () => 1_800_000_000_000 }).creer({ sujet: "personne-1", tenantId: "11111111-1111-4111-8111-111111111111", connexionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", outil: "microsoft-365", fournisseur: "microsoft", genre: "autorisation", locataire });

describe("OAuth Microsoft", () => {
  it("[A-388] PKCE absent : l'adresse porte code_challenge S256, et un échange sans code_verifier est refusé avant l'appel", async () => {
    const tx = await nouvelle(LOC);
    const u = new URL(adresseAutorisation(tx, CFG));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(createHash("sha256").update(tx.verifier).digest("base64url"));
    expect(u.searchParams.get("state")).toBe(tx.state);
    let appels = 0;
    const f = (async () => { appels++; return new Response("{}"); }) as typeof fetch;
    await expect(echanger(f, { ...tx, verifier: "" }, "code-fictif", CFG)).rejects.toMatchObject({ code: "pkce_absent" });
    expect(appels).toBe(0);
  });

  it("[A-388] l'adresse d'autorisation vise le locataire attendu (jamais common ni organizations) ; redirect_uri fixe, aucun paramètre de retour lu", async () => {
    const tx = await nouvelle(LOC);
    const u = new URL(adresseAutorisation(tx, CFG));
    expect(u.origin + u.pathname).toBe(`https://login.microsoftonline.com/${LOC}/oauth2/v2.0/authorize`);
    expect(u.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(u.searchParams.get("scope")).toContain("offline_access");
    expect(new URL(adresseAccordAdmin(tx, CFG)).pathname).toBe(`/${LOC}/v2.0/adminconsent`);
    for (const mauvais of ["common", "organizations", "consumers", "../x", ""]) {
      const t = await nouvelle(mauvais);
      expect(() => adresseAutorisation(t, CFG)).toThrow();
      expect(() => adresseAccordAdmin(t, CFG)).toThrow();
    }
    expect(adresseAutorisation.length).toBe(2);
  });
});
