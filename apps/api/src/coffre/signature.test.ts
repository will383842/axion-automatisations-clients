import { generateKeyPairSync, sign, verify, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { ErreurCoffre } from "./coffre.js";
import { creerSignature } from "./signature.js";

// Imitation du transit d'OpenBao pour la clé Ed25519 (le vrai serveur est essayé dans signature.int.test.ts).
// Droits par rôle : ils sont comparés aux vrais fichiers de politiques dans cles-echanges.test.ts.
const DROITS: Record<string, string[]> = {
  signature: ["POST sign", "POST verify", "GET keys"],
  api: [],
};
const URL_BAO = "http://openbao.test:8200";
const rep = (statut: number, corps: unknown) => new Response(statut === 204 ? null : JSON.stringify(corps), { status: statut });

function creerFauxTransit() {
  const etat = { scelle: false, appels: [] as { methode: string; url: string; corps: string }[], jetons: new Map<string, string>(), cle: undefined as undefined | { privee: KeyObject; publique: KeyObject; exportable: unknown; sauvegarde: unknown }, forcer: undefined as undefined | ((chemin: string) => unknown) };
  const jeton = (role: string) => { const j = `jeton-${randomUUID()}`; etat.jetons.set(j, role); return j; };
  const f: typeof fetch = async (entree, init) => {
    const url = new URL(String(entree));
    const methode = (init?.method ?? "GET").toUpperCase();
    const corps = typeof init?.body === "string" ? init.body : "";
    etat.appels.push({ methode, url: String(entree), corps });
    if (etat.scelle) return rep(503, { errors: ["Vault is sealed"] });
    const chemin = url.pathname.replace(/^\/v1\/transit\//, "");
    const role = etat.jetons.get(new Headers(init?.headers).get("x-vault-token") ?? "") ?? "";
    const [action, nom] = chemin.split("/");
    if (role !== "racine" && !(DROITS[role] ?? []).includes(`${methode} ${action}`)) return rep(403, { errors: ["permission denied"] });
    if (nom !== "modules-signature") return rep(404, { errors: [] });
    if (etat.forcer) { const r = etat.forcer(chemin); if (r !== undefined) return rep(200, r); }
    const json = corps ? (JSON.parse(corps) as Record<string, unknown>) : {};
    if (action === "keys" && methode === "POST") {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      etat.cle = { privee: privateKey, publique: publicKey, exportable: json.exportable, sauvegarde: json.allow_plaintext_backup };
      return rep(204, null);
    }
    if (!etat.cle) return rep(404, { errors: [] });
    if (action === "keys") return rep(200, { data: { type: "ed25519", exportable: etat.cle.exportable, allow_plaintext_backup: etat.cle.sauvegarde } });
    if (action === "sign") return rep(200, { data: { signature: `vault:v1:${sign(null, Buffer.from(String(json.input), "base64"), etat.cle.privee).toString("base64")}` } });
    if (action === "verify") {
      const s = String(json.signature).replace(/^vault:v1:/, "");
      return rep(200, { data: { valid: verify(null, Buffer.from(String(json.input), "base64"), etat.cle.publique, Buffer.from(s, "base64")) } });
    }
    if (action === "backup") return rep(500, { errors: ["1 error occurred:\n\t* exporting is disallowed on the policy"] });
    return rep(404, { errors: [] });
  };
  return { etat, jeton, fetch: f };
}

let bao: ReturnType<typeof creerFauxTransit>;
const signataire = (role: string) => creerSignature({ url: URL_BAO, jeton: bao.jeton(role), fetch: bao.fetch });
beforeEach(() => { bao = creerFauxTransit(); bao.etat.jetons.set("racine", "racine"); });
const refus = async (p: Promise<unknown>, code?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ErreurCoffre);
  if (code) expect((e as ErreurCoffre).code).toBe(code);
  return e as ErreurCoffre;
};
const octets = () => Buffer.from(`module-${randomUUID()}`);

describe("signature des modules : clé Ed25519 dans OpenBao", () => {
  it("[A-193] la clé est créée en ed25519, non exportable, sans copie en clair", async () => {
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: bao.fetch }).creerCle();
    const c = JSON.parse(bao.etat.appels[0]?.corps ?? "{}") as Record<string, unknown>;
    expect(c).toEqual({ type: "ed25519", exportable: false });
    expect(c).not.toHaveProperty("allow_plaintext_backup");
    expect(await signataire("signature").etatCle()).toEqual({ type: "ed25519", exportable: false, sauvegardeEnClair: false });
  });
  it("[A-193] etatCle refuse une clé exportable ou avec copie en clair", async () => {
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: bao.fetch }).creerCle();
    for (const [exportable, sauvegarde] of [[true, undefined], [false, true], [true, true]]) {
      bao.etat.cle!.exportable = exportable;
      bao.etat.cle!.sauvegarde = sauvegarde;
      await refus(signataire("signature").etatCle(), "coffre_indisponible");
    }
  });
  it("[A-193] le transit refuse la sauvegarde d'une clé non exportable : le paquet en clair est impossible", async () => {
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: bao.fetch }).creerCle();
    const r = await bao.fetch(`${URL_BAO}/v1/transit/backup/modules-signature`, { headers: { "x-vault-token": "racine" } });
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).toContain("exporting is disallowed");
  });
  it("[A-193] le code n'appelle jamais l'export de la clé privée et refuse de créer une clé exportable", async () => {
    const source = readFileSync(fileURLToPath(new URL("./signature.ts", import.meta.url)), "utf8");
    expect(source).not.toContain("transit/export");
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: bao.fetch }).creerCle();
    bao.etat.cle!.exportable = true;
    await refus(signataire("signature").etatCle(), "coffre_indisponible");
  });
  it("[A-193] signer puis vérifier une signature Ed25519 par OpenBao ; un message ou une signature modifiés sont refusés", async () => {
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: bao.fetch }).creerCle();
    const s = signataire("signature"), m = octets();
    const signature = await s.signer(m);
    expect(signature).toMatch(/^vault:v1:[A-Za-z0-9+/]+={0,2}$/);
    expect(await s.verifier(m, signature)).toBe(true);
    expect(await s.verifier(octets(), signature)).toBe(false);
    const brut = Buffer.from(signature.slice("vault:v1:".length), "base64");
    brut[0] = (brut[0] ?? 0) ^ 1;
    expect(await s.verifier(m, `vault:v1:${brut.toString("base64")}`)).toBe(false);
  });
  it.each(["", "abc", "vault:v1:", "vault:v1:../keys", "vault:v1:a b", "vault:v1:a\n", "VAULT:v1:AAAA", "vault:v:AAAA"])(
    "[A-193] signature mal formée %j refusée sans appel réseau",
    async (signature) => {
      expect(await signataire("signature").verifier(octets(), signature)).toBe(false);
      expect(bao.etat.appels).toEqual([]);
    },
  );
  it("[A-193] une réponse falsifiée du serveur (signature de forme inconnue, valid non booléen) est refusée", async () => {
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: bao.fetch }).creerCle();
    bao.etat.forcer = (c) => (c.startsWith("sign") ? { data: { signature: "pas-une-signature" } } : { data: { valid: "true" } });
    await refus(signataire("signature").signer(octets()), "coffre_indisponible");
    await refus(signataire("signature").verifier(octets(), "vault:v1:AAAA"), "coffre_indisponible");
  });
  it("[A-193] OpenBao scellé → coffre_scelle, aucune signature de repli", async () => {
    bao.etat.scelle = true;
    await refus(signataire("signature").signer(octets()), "coffre_scelle");
    await refus(signataire("signature").verifier(octets(), "vault:v1:AAAA"), "coffre_scelle");
  });
});
