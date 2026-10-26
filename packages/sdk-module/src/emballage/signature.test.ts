import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ClePublique } from "./cles-publiques.ts";
import { SignataireMemoire, empreinteArtefact, signerArtefact } from "./signer.ts";
import { verifierArtefact } from "./verifier.ts";

const octets = (t: string) => new TextEncoder().encode(t);
const base = () => ({ "module.js": octets("export default 1;"), "manifest.json": octets('{"nom":"demo"}') });

function cleDeTest(idCle = "test-1", revoquee = false) {
  const signataire = new SignataireMemoire(idCle);
  const cle: ClePublique = { idCle, publique: signataire.clePublique, ...(revoquee ? { revoquee: true } : {}) };
  return { signataire, cle };
}

describe("signature des artefacts", () => {
  it("[C-018] un artefact signé par la clé de test est accepté", () => {
    const { signataire, cle } = cleDeTest();
    const a = signerArtefact(base(), signataire);
    expect(verifierArtefact(a, [cle]).ok).toBe(true);
  });

  it("[A-304] un octet changé dans module.js → module_non_signe", () => {
    const { signataire, cle } = cleDeTest();
    const a = signerArtefact(base(), signataire);
    a["module.js"] = octets("export default 2;");
    expect(verifierArtefact(a, [cle])).toEqual({ ok: false, code: "module_non_signe" });
  });

  it("[A-304] module.js remplacé et empreinte recalculée sans nouvelle signature → refus", () => {
    const { signataire, cle } = cleDeTest();
    const a = signerArtefact(base(), signataire);
    a["module.js"] = octets("export default 2;");
    const sig = JSON.parse(new TextDecoder().decode(a["signature.json"]));
    sig.empreinte = empreinteArtefact(a);
    a["signature.json"] = octets(JSON.stringify(sig));
    expect(verifierArtefact(a, [cle])).toEqual({ ok: false, code: "module_non_signe" });
  });

  it("[A-304] un manifest.json changé → refus", () => {
    const { signataire, cle } = cleDeTest();
    const a = signerArtefact(base(), signataire);
    a["manifest.json"] = octets('{"nom":"autre"}');
    expect(verifierArtefact(a, [cle])).toEqual({ ok: false, code: "module_non_signe" });
  });

  it("[C-018] une signature d'une clé inconnue → refus", () => {
    const { signataire } = cleDeTest("inconnue");
    const { cle } = cleDeTest("test-1");
    const a = signerArtefact(base(), signataire);
    expect(verifierArtefact(a, [cle])).toEqual({ ok: false, code: "module_non_signe" });
  });

  it("[C-018] une clé révoquée → refus", () => {
    const { signataire, cle } = cleDeTest("test-1", true);
    const a = signerArtefact(base(), signataire);
    expect(verifierArtefact(a, [cle])).toEqual({ ok: false, code: "module_non_signe" });
  });

  it("[C-018] une signature valide sur un autre préfixe de domaine → refus", () => {
    const { privee, publique } = (() => {
      const p = generateKeyPairSync("ed25519");
      return { privee: p.privateKey, publique: p.publicKey.export({ type: "spki", format: "pem" }).toString() };
    })();
    const a = base();
    const empreinte = empreinteArtefact(a);
    const signature = sign(null, Buffer.from(`autre-chose\nv1\n${empreinte}`), privee).toString("base64");
    const art = { ...a, "signature.json": octets(JSON.stringify({ v: 1, algo: "ed25519", idCle: "k", empreinte, signature })) };
    expect(verifierArtefact(art, [{ idCle: "k", publique }])).toEqual({ ok: false, code: "module_non_signe" });
  });

  it("[C-471] un artefact sans signature.json → refus", () => {
    const { cle } = cleDeTest();
    expect(verifierArtefact(base(), [cle])).toEqual({ ok: false, code: "module_non_signe" });
  });

  it("[C-471] un signature.json illisible ou d'un autre algorithme → refus", () => {
    const { signataire, cle } = cleDeTest();
    const a = signerArtefact(base(), signataire);
    a["signature.json"] = octets("pas du json");
    expect(verifierArtefact(a, [cle]).ok).toBe(false);
    const b = signerArtefact(base(), signataire);
    const sig = JSON.parse(new TextDecoder().decode(b["signature.json"]));
    b["signature.json"] = octets(JSON.stringify({ ...sig, algo: "rsa" }));
    expect(verifierArtefact(b, [cle]).ok).toBe(false);
  });

  it("[A-302] le signataire en mémoire refuse de démarrer en production", () => {
    const avant = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect(() => new SignataireMemoire("k")).toThrow();
    } finally {
      if (avant === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = avant;
    }
  });

  it("[A-302] la liste épinglée de production est vide tant que le coffre n'a pas fourni la clé", async () => {
    const { CLES_PUBLIQUES } = await import("./cles-publiques.ts");
    expect(CLES_PUBLIQUES).toEqual([]);
  });
});
