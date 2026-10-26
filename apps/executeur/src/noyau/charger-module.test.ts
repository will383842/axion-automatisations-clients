import { afterEach, describe, expect, it } from "vitest";
import { SignataireMemoire, signerArtefact } from "../../../../packages/sdk-module/src/emballage/signer.js";
import { type ClePublique } from "../../../../packages/sdk-module/src/emballage/cles-publiques.js";
import { chargerModule } from "./charger-module.js";

const octets = (t: string) => new TextEncoder().encode(t);
const temoin = globalThis as { __temoinModule?: boolean };
const JS = "globalThis.__temoinModule = true; export default 42;";
const base = () => ({ "module.js": octets(JS), "manifest.json": octets('{"nom":"demo"}') });

function cle() {
  const s = new SignataireMemoire("test-1");
  const c: ClePublique = { idCle: "test-1", publique: s.clePublique };
  return { s, c };
}

afterEach(() => {
  delete temoin.__temoinModule;
});

describe("chargerModule", () => {
  it("[C-018] un artefact signé par la clé de test se charge", async () => {
    const { s, c } = cle();
    const m = await chargerModule(signerArtefact(base(), s), [c]);
    expect(m["default"]).toBe(42);
  });

  it("[A-304] un octet changé dans module.js → module_non_signe, et le module n'est pas évalué", async () => {
    const { s, c } = cle();
    const a = signerArtefact(base(), s);
    a["module.js"] = octets(JS + " ");
    await expect(chargerModule(a, [c])).rejects.toMatchObject({ code: "module_non_signe" });
    expect(temoin.__temoinModule).toBeUndefined();
  });

  it("[A-304] un manifest.json changé → refus sans évaluation", async () => {
    const { s, c } = cle();
    const a = signerArtefact(base(), s);
    a["manifest.json"] = octets('{"nom":"autre"}');
    await expect(chargerModule(a, [c])).rejects.toMatchObject({ code: "module_non_signe" });
    expect(temoin.__temoinModule).toBeUndefined();
  });

  it("[C-471] un artefact sans signature.json → refus sans évaluation", async () => {
    const { c } = cle();
    await expect(chargerModule(base(), [c])).rejects.toMatchObject({ code: "module_non_signe" });
    expect(temoin.__temoinModule).toBeUndefined();
  });

  it("[A-304] le module est évalué depuis les octets vérifiés, pas depuis une relecture", async () => {
    const { s, c } = cle();
    const a = signerArtefact(base(), s);
    const lecteur = Object.defineProperty({ ...a }, "module.js", {
      enumerable: true,
      get: (() => {
        let n = 0;
        return () => (++n === 1 ? a["module.js"] : octets("globalThis.__temoinModule = 'relu';"));
      })(),
    });
    await chargerModule(lecteur, [c]);
    expect(temoin.__temoinModule).toBe(true);
  });
});
