import { createPublicKey, generateKeyPairSync, sign, verify, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { construireManifeste, creerSignatureExports, verifierExport, empreinteSha256 } from "./manifeste.js";

const A = "11111111-1111-4111-8111-111111111111";
const DEMANDE = "33333333-3333-4333-8333-333333333333";
const URL_BAO = "http://openbao.test:8200";
const brute = (publique: ReturnType<typeof generateKeyPairSync>["publicKey"]) => (publique.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64");

// Imitation du transit : une paire Ed25519 ; on note chaque appel pour prouver qu'aucune clé privée ne sort.
function fauxTransit() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const appels: string[] = [];
  const f: typeof fetch = async (entree, init) => {
    const url = new URL(String(entree));
    const chemin = url.pathname.replace(/^\/v1\//, "");
    appels.push(`${(init?.method ?? "GET").toUpperCase()} ${chemin}`);
    const corps = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
    if (chemin === "transit/sign/exports-signature") return new Response(JSON.stringify({ data: { signature: `vault:v1:${sign(null, Buffer.from(corps["input"]!, "base64"), privateKey).toString("base64")}` } }));
    if (chemin === "transit/keys/exports-signature") return new Response(JSON.stringify({ data: { type: "ed25519", exportable: false, keys: { "1": { public_key: brute(publicKey) } } } }));
    return new Response(JSON.stringify({ errors: ["permission denied"] }), { status: 403 });
  };
  return { appels, publique: brute(publicKey), signature: creerSignatureExports({ url: URL_BAO, jeton: `jeton-${randomUUID()}`, fetch: f }) };
}

const FICHIERS = new Map<string, Buffer>([
  ["donnees/commun/personnes.csv", Buffer.from("id,nom\r\n1,Camille\r\n")],
  ["fichiers/devis.pdf", Buffer.from("%PDF-essai")],
]);
async function exportSigne(t = fauxTransit()) {
  const m = construireManifeste({ clientId: A, demande: DEMANDE, versionStructure: 4, genereLe: new Date("2026-11-02T10:00:00Z"), fichiers: [...FICHIERS].map(([fichier, octets]) => ({ fichier, taille: octets.length, sha256: empreinteSha256(octets), date: "2026-11-02T10:00:00.000Z" })) });
  const signature = await t.signature.signer(m);
  return { t, zip: new Map([...FICHIERS, ["manifeste.json", m], ["manifeste.sig", Buffer.from(signature)]]) };
}

describe("manifeste signé de l'export", () => {
  it("[B-374] le manifeste liste les empreintes SHA-256 et sa signature se vérifie avec la clé publique", async () => {
    const { t, zip } = await exportSigne();
    const manifeste = JSON.parse(zip.get("manifeste.json")!.toString("utf8")) as { client: string; version: number; fichiers: { fichier: string; taille: number; sha256: string; date: string }[] };
    expect(manifeste.client).toBe(A);
    expect(manifeste.fichiers.map((f) => f.fichier)).toEqual([...FICHIERS.keys()]);
    for (const f of manifeste.fichiers) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifierExport(zip, t.publique)).toEqual({ ok: true });
    // Seule la signature par OpenBao et la lecture de la clé publique ont été demandées.
    expect([...new Set(t.appels)].sort()).toEqual(["POST transit/sign/exports-signature"]);
    expect(await t.signature.clePublique()).toBe(t.publique);
  });

  it("[B-374] un fichier modifié dans le ZIP fait échouer la vérification", async () => {
    const { t, zip } = await exportSigne();
    zip.set("fichiers/devis.pdf", Buffer.from("%PDF-modifie"));
    expect(verifierExport(zip, t.publique)).toEqual({ ok: false, raison: "empreinte_differente" });
  });

  it("[B-374] un fichier ajouté ou retiré fait échouer la vérification", async () => {
    const { t, zip } = await exportSigne();
    const ajout = new Map(zip).set("donnees/commun/intrus.csv", Buffer.from("x"));
    expect(verifierExport(ajout, t.publique)).toEqual({ ok: false, raison: "fichier_non_liste" });
    const retrait = new Map(zip);
    retrait.delete("fichiers/devis.pdf");
    expect(verifierExport(retrait, t.publique)).toEqual({ ok: false, raison: "fichier_absent" });
  });

  it("[B-374] un manifeste remplacé avec la signature d'une autre clé fait échouer la vérification", async () => {
    const { t, zip } = await exportSigne();
    const autre = fauxTransit();
    const faux = { ...JSON.parse(zip.get("manifeste.json")!.toString("utf8")), client: "22222222-2222-4222-8222-222222222222" };
    const octets = Buffer.from(JSON.stringify(faux, null, 2) + "\n");
    const remplace = new Map(zip).set("manifeste.json", octets).set("manifeste.sig", Buffer.from(await autre.signature.signer(octets)));
    // La clé de contrôle vient de l'extérieur (verifier.txt, documentation), jamais du ZIP : la clé d'un autre ne passe pas.
    expect(verifierExport(remplace, t.publique)).toEqual({ ok: false, raison: "signature_invalide" });
    expect(verifierExport(new Map(zip).set("manifeste.json", octets), t.publique)).toEqual({ ok: false, raison: "signature_invalide" });
  });

  it("[B-374] la vérification refuse une signature mal formée ou absente sans lever d'erreur", async () => {
    const { t, zip } = await exportSigne();
    expect(verifierExport(new Map(zip).set("manifeste.sig", Buffer.from("n'importe quoi")), t.publique)).toEqual({ ok: false, raison: "signature_invalide" });
    const sans = new Map(zip);
    sans.delete("manifeste.sig");
    expect(verifierExport(sans, t.publique)).toEqual({ ok: false, raison: "manifeste_absent" });
    expect(verifierExport(zip, "pas une clé")).toEqual({ ok: false, raison: "cle_invalide" });
    // Contrôle croisé avec node:crypto seul : un client peut vérifier sans nous.
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(t.publique, "base64")]);
    const sig = Buffer.from(zip.get("manifeste.sig")!.toString().replace(/^vault:v1:/, ""), "base64");
    expect(verify(null, zip.get("manifeste.json")!, createPublicKey({ key: spki, format: "der", type: "spki" }), sig)).toBe(true);
  });
});
