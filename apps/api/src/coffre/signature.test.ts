import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { ErreurCoffre } from "./coffre.js";
import { creerSignature } from "./signature.js";

// Imitation du transit d'OpenBao pour la clé Ed25519 (le vrai serveur est essayé dans signature.int.test.ts).
// Droits par rôle : ils sont comparés aux vrais fichiers de politiques dans cles-echanges.test.ts.
const DROITS: Record<string, string[]> = {
  signature: ["POST sign", "POST verify", "GET keys"],
  secours: ["GET backup", "GET keys"],
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
    if (action === "restore") {
      try {
        const { pem } = JSON.parse(Buffer.from(String(json.backup), "base64").toString()) as { pem: string };
        const privee = createPrivateKey(pem);
        etat.cle = { privee, publique: createPublicKey(privee), exportable: false, sauvegarde: true };
        return rep(204, null);
      } catch {
        return rep(400, { errors: ["invalid backup"] });
      }
    }
    if (!etat.cle) return rep(404, { errors: [] });
    if (action === "keys") return rep(200, { data: { type: "ed25519", exportable: etat.cle.exportable, allow_plaintext_backup: etat.cle.sauvegarde } });
    if (action === "sign") return rep(200, { data: { signature: `vault:v1:${sign(null, Buffer.from(String(json.input), "base64"), etat.cle.privee).toString("base64")}` } });
    if (action === "verify") {
      const s = String(json.signature).replace(/^vault:v1:/, "");
      return rep(200, { data: { valid: verify(null, Buffer.from(String(json.input), "base64"), etat.cle.publique, Buffer.from(s, "base64")) } });
    }
    if (action === "backup") {
      if (etat.cle.sauvegarde !== true) return rep(400, { errors: ["plaintext backup is disallowed"] });
      return rep(200, { data: { backup: Buffer.from(JSON.stringify({ pem: etat.cle.privee.export({ type: "pkcs8", format: "pem" }) })).toString("base64") } });
    }
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
  it("[A-193] la clé est créée en ed25519, non exportable, avec copie de secours permise", async () => {
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: bao.fetch }).creerCle();
    const c = JSON.parse(bao.etat.appels[0]?.corps ?? "{}") as Record<string, unknown>;
    expect(c).toMatchObject({ type: "ed25519", exportable: false, allow_plaintext_backup: true });
    expect(await signataire("signature").etatCle()).toEqual({ type: "ed25519", exportable: false, sauvegardePossible: true });
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

describe("copie de secours de la clé de signature", () => {
  it("[A-303] @isolation le jeton de signature ne sort pas la copie, le jeton de secours ne signe pas", async () => {
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: bao.fetch }).creerCle();
    await refus(signataire("signature").exporterSecours(), "refuse");
    await refus(signataire("api").exporterSecours(), "refuse");
    await refus(signataire("secours").signer(octets()), "refuse");
    expect((await signataire("secours").exporterSecours()).length).toBeGreaterThan(0);
  });
  it("[A-303] le paquet de secours restauré dans un second OpenBao neuf vérifie une signature faite avant", async () => {
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: bao.fetch }).creerCle();
    const m = octets(), signature = await signataire("signature").signer(m);
    const paquet = await signataire("secours").exporterSecours();
    const second = creerFauxTransit();
    second.etat.jetons.set("racine", "racine");
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: second.fetch }).restaurerSecours(paquet);
    const s2 = creerSignature({ url: URL_BAO, jeton: second.jeton("signature"), fetch: second.fetch });
    expect(await s2.verifier(m, signature)).toBe(true);
  });
  it("[A-303] un paquet altéré ou vide est refusé à la restauration", async () => {
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: bao.fetch }).creerCle();
    const paquet = await signataire("secours").exporterSecours();
    paquet[3] = (paquet[3] ?? 0) ^ 0xff;
    const racine = creerSignature({ url: URL_BAO, jeton: "racine", fetch: creerFauxTransit().fetch });
    await refus(racine.restaurerSecours(paquet));
    await refus(racine.restaurerSecours(Buffer.alloc(0)), "requete_refusee");
  });
  it("[A-303] la copie sans permission, scellée ou mal formée ne recopie jamais le paquet dans l'erreur", async () => {
    await creerSignature({ url: URL_BAO, jeton: "racine", fetch: bao.fetch }).creerCle();
    const paquet = (await signataire("secours").exporterSecours()).toString("base64");
    const erreurs = [await refus(signataire("signature").exporterSecours())];
    bao.etat.forcer = () => ({ data: { backup: "%%pas du base64%%" } });
    erreurs.push(await refus(signataire("secours").exporterSecours(), "coffre_indisponible"));
    bao.etat.forcer = undefined;
    bao.etat.scelle = true;
    erreurs.push(await refus(signataire("secours").exporterSecours(), "coffre_scelle"));
    for (const e of erreurs) expect(`${e.message}${e.stack ?? ""}`).not.toContain(paquet);
  });
});
