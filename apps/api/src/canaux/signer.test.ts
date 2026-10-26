import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EN_TETES, verifier } from "../../../../packages/contrats/src/commun/signature.js";
import type { CleEchange, Sens } from "../coffre/cles-echanges.js";
import { ErreurApi } from "../plugins/erreurs.js";
import { creerSigneur } from "./signer.js";

const MAINTENANT = 1_800_000_000;
const secret = () => randomBytes(32);

function fournisseur() {
  const appels: string[] = [];
  const cles: Record<string, CleEchange> = { "c1/emission": { kid: "emi-c1", secret: secret() }, "c3/emission": { kid: "emi-c3", secret: secret() } };
  return { appels, cles, source: { async cleActive(c: string, s: Sens) { appels.push(`${c}/${s}`); return cles[`${c}/${s}`] as CleEchange; } } };
}

describe("signature des requêtes sortantes", () => {
  it("[A-345] chaque envoi porte les trois en-têtes, signés avec la clé du sens console vers l'autre système", async () => {
    const f = fournisseur();
    const signeur = creerSigneur({ cles: f.source, actif: () => true });
    const corps = '{"x":1}';
    const h = await signeur.signerRequete("c1", "POST", "/api/v1/ordres?a=b", corps, MAINTENANT);
    expect(h[EN_TETES.cle]).toBe("emi-c1");
    expect(h[EN_TETES.horodatage]).toBe(String(MAINTENANT));
    const cle = f.cles["c1/emission"] as CleEchange;
    expect(verifier(cle.secret.toString("base64"), h[EN_TETES.horodatage] as string, "POST", "/api/v1/ordres?a=b", corps, h[EN_TETES.signature] as string, MAINTENANT)).toEqual({ ok: true });
    const autre = f.cles["c3/emission"] as CleEchange;
    expect(verifier(autre.secret.toString("base64"), String(MAINTENANT), "POST", "/api/v1/ordres?a=b", corps, h[EN_TETES.signature] as string, MAINTENANT).ok).toBe(false);
  });

  it("[C-510] la clé est gardée en mémoire au plus 5 minutes", async () => {
    const f = fournisseur();
    const signeur = creerSigneur({ cles: f.source, actif: () => true });
    await signeur.signerRequete("c1", "GET", "/a", "", MAINTENANT);
    await signeur.signerRequete("c1", "GET", "/a", "", MAINTENANT + 299);
    expect(f.appels).toEqual(["c1/emission"]);
    await signeur.signerRequete("c1", "GET", "/a", "", MAINTENANT + 300);
    expect(f.appels).toHaveLength(2);
  });

  it("[C-510] porte fermée : rien n'est signé ni envoyé", async () => {
    const f = fournisseur();
    const signeur = creerSigneur({ cles: f.source, actif: () => false });
    await expect(signeur.signerRequete("c3", "POST", "/a", "{}", MAINTENANT)).rejects.toMatchObject({ code: "porte_fermee" });
    await expect(signeur.signerRequete("c3", "POST", "/a", "{}", MAINTENANT)).rejects.toBeInstanceOf(ErreurApi);
    expect(f.appels).toHaveLength(0);
  });

  it("[C-344] chaque envoi est journalisé sans corps ni signature", async () => {
    const f = fournisseur();
    const lignes: object[] = [];
    const signeur = creerSigneur({ cles: f.source, actif: () => true, journal: { info: (o) => void lignes.push(o) } });
    const h = await signeur.signerRequete("c1", "POST", "/api/v1/ordres?jeton=abc", '{"champ":"valeur-sensible"}', MAINTENANT);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({ canal: "c1", sens: "sortant", route: "/api/v1/ordres", cle: "emi-c1", resultat: "ok" });
    expect(JSON.stringify(lignes)).not.toMatch(new RegExp(`valeur-sensible|jeton=abc|${(h[EN_TETES.signature] as string).slice(3)}`));
  });
});
