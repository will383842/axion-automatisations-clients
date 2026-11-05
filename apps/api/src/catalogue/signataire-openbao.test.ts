import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ClePublique } from "../../../../packages/sdk-module/src/emballage/cles-publiques.ts";
import { chaineASigner, empreinteArtefact, FICHIER_SIGNATURE, type Artefact } from "../../../../packages/sdk-module/src/emballage/signer.ts";
import { verifierArtefact } from "../../../../packages/sdk-module/src/emballage/verifier.ts";
import { ErreurCoffre } from "../coffre/coffre.js";
import { creerSignataireOpenBao } from "./signataire-openbao.js";

// LISTE D'ATTAQUES (zone secrets + publication d'artefacts), un test au moins pour chacune :
//  1. clé exportable : la politique ne donne aucun droit sur la configuration d'une clé, initialiser.sh crée la clé avec exportable=false.
//  2. clé de la recette utilisée en production : la liste épinglée de production ne contient que modules-publication ; une signature de recette, même relabellisée, est refusée.
//  3. artefact modifié après signature : l'empreinte ne correspond plus ; on ne peut pas non plus faire signer autre chose qu'une empreinte (chaîne sans préfixe, texte libre).
//  4. rejeu : la signature d'un artefact collée sur un autre est refusée ; la signature d'une version de clé ne vaut pas sous l'identifiant d'une autre.
//  5. panne du coffre (scellé, injoignable, réponse truquée) : aucune signature, aucun repli sur une clé locale, aucun secret dans l'erreur.
const racine = (chemin: string) => readFileSync(fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url)), "utf8");
const octets = (t: string) => new TextEncoder().encode(t);
const base = (): Artefact => ({ "module.js": octets("export default 1;"), "manifest.json": octets('{"nom":"demo"}') });
const URL_BAO = "http://openbao.test:8200";
const rep = (statut: number, corps: unknown) => new Response(statut === 204 ? null : JSON.stringify(corps), { status: statut });

// Droits du jeton « publication » lus dans le VRAI fichier de politique.
function droitsPublication(): { chemin: string; capacites: string[] }[] {
  return [...racine("ops/socle/openbao/politiques/publication.hcl").matchAll(/path\s+"([^"]+)"\s*\{\s*capabilities\s*=\s*\[([^\]]*)\]\s*\}/g)].map((m) => ({
    chemin: m[1] ?? "",
    capacites: [...(m[2] ?? "").matchAll(/"([a-z]+)"/g)].map((c) => c[1] ?? ""),
  }));
}

// Imitation du transit d'OpenBao : clés Ed25519 versionnées, signature « vault:v<n>:<base64> », export refusé.
function creerFauxTransit() {
  const cles = new Map<string, { version: number; paires: Map<number, { privee: KeyObject; publique: KeyObject }> }>();
  const etat = { scelle: false, coupe: false, corpsFixe: undefined as unknown, appels: [] as { methode: string; chemin: string; corps: string }[], jetons: new Map<string, string>() };
  const creer = (nom: string) => {
    const p = generateKeyPairSync("ed25519");
    cles.set(nom, { version: 1, paires: new Map([[1, { privee: p.privateKey, publique: p.publicKey }]]) });
  };
  const tourner = (nom: string) => {
    const c = cles.get(nom)!;
    const p = generateKeyPairSync("ed25519");
    c.version += 1;
    c.paires.set(c.version, { privee: p.privateKey, publique: p.publicKey });
  };
  const publique = (nom: string, version: number): ClePublique => ({ idCle: `${nom}:v${version}`, publique: cles.get(nom)!.paires.get(version)!.publique.export({ type: "spki", format: "pem" }).toString() });
  const jeton = (role: string) => { const j = `jeton-${randomUUID()}`; etat.jetons.set(j, role); return j; };
  const f: typeof fetch = async (entree, init) => {
    const url = new URL(String(entree));
    const methode = (init?.method ?? "GET").toUpperCase();
    const chemin = url.pathname.replace(/^\/v1\//, "");
    const corps = typeof init?.body === "string" ? init.body : "";
    etat.appels.push({ methode, chemin, corps });
    if (etat.coupe) throw new TypeError("fetch failed");
    if (etat.scelle) return rep(503, { errors: ["Vault is sealed"] });
    const role = etat.jetons.get(new Headers(init?.headers).get("x-vault-token") ?? "");
    const capacite = methode === "GET" ? "read" : "update";
    // « recette » : droit de TEST seulement (la politique de la recette n'est pas livrée par T4-26) ; « publication » : le vrai fichier.
    const droits = role === "publication" ? droitsPublication() : role === "recette" ? [{ chemin: "transit/sign/modules-recette", capacites: ["update"] }] : [];
    if (!droits.some((d) => d.chemin === chemin && d.capacites.includes(capacite))) return rep(403, { errors: ["permission denied"] });
    if (etat.corpsFixe !== undefined) return rep(200, etat.corpsFixe);
    const m = /^transit\/sign\/(modules-[a-z]+)$/.exec(chemin);
    const cle = m ? cles.get(m[1] ?? "") : undefined;
    if (!cle) return rep(404, { errors: [] });
    const entree64 = String((JSON.parse(corps) as { input?: unknown }).input);
    const signature = sign(null, Buffer.from(entree64, "base64"), cle.paires.get(cle.version)!.privee).toString("base64");
    return rep(200, { data: { signature: `vault:v${cle.version}:${signature}` } });
  };
  return { etat, creer, tourner, publique, jeton, fetch: f };
}

function monde() {
  const bao = creerFauxTransit();
  bao.creer("modules-publication");
  bao.creer("modules-recette");
  const signataire = (cle: "modules-publication" | "modules-recette") => creerSignataireOpenBao({ url: URL_BAO, jeton: bao.jeton(cle === "modules-publication" ? "publication" : "recette"), fetch: bao.fetch }, cle);
  return { bao, signataire };
}
const refus = { ok: false, code: "module_non_signe" } as const;

describe("signataire OpenBao (clé non exportable du coffre)", () => {
  it("[C-018] la signature du coffre est convertie vers signature.json et garde la version de clé dans idCle", async () => {
    const { bao, signataire } = monde();
    const a = await signataire("modules-publication").signerArtefact(base());
    const s = JSON.parse(new TextDecoder().decode(a[FICHIER_SIGNATURE])) as Record<string, string>;
    expect(s).toMatchObject({ v: 1, algo: "ed25519", idCle: "modules-publication:v1", empreinte: empreinteArtefact(base()) });
    expect(s["signature"]).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(verifierArtefact(a, [bao.publique("modules-publication", 1)]).ok).toBe(true);
  });

  it("[C-018] la console n'envoie au coffre que le préfixe de domaine suivi de l'empreinte, sur la seule route de signature de la clé demandée", async () => {
    const { bao, signataire } = monde();
    const empreinte = createHash("sha256").update("x").digest("hex");
    await signataire("modules-publication").signer(empreinte);
    expect(bao.etat.appels).toHaveLength(1);
    expect(bao.etat.appels[0]).toMatchObject({ methode: "POST", chemin: "transit/sign/modules-publication" });
    expect(JSON.parse(bao.etat.appels[0]?.corps ?? "{}")).toEqual({ input: Buffer.from(chaineASigner(empreinte)).toString("base64") });
  });

  it("[C-018] attaque 1 : on ne fait signer que des empreintes SHA-256 (texte libre, chaîne déjà préfixée, majuscules, deux empreintes) → refus sans appel au coffre", async () => {
    const { bao, signataire } = monde();
    const e = createHash("sha256").update("x").digest("hex");
    for (const mauvais of ["", "bonjour", chaineASigner(e), `${e}\n${e}`, e.toUpperCase(), e.slice(1), `${e} `, `${e}\0`]) {
      await expect(signataire("modules-publication").signer(mauvais), JSON.stringify(mauvais)).rejects.toMatchObject({ code: "requete_refusee" });
    }
    expect(bao.etat.appels).toEqual([]);
  });

  it("[C-018] attaque 1 : la signature n'est valable que pour l'artefact dont l'empreinte a été signée (autre empreinte → refus)", async () => {
    const { bao, signataire } = monde();
    const sA = await signataire("modules-publication").signerArtefact(base());
    const autre = { ...base(), "module.js": octets("export default 2;") };
    const sB = await signataire("modules-publication").signerArtefact(autre);
    // Signature de l'artefact B collée sur A : l'empreinte écrite ne correspond plus.
    expect(verifierArtefact({ ...sA, [FICHIER_SIGNATURE]: sB[FICHIER_SIGNATURE] as Uint8Array }, [bao.publique("modules-publication", 1)])).toEqual(refus);
    // Signature de B sous l'empreinte de A : la signature ne correspond plus.
    const faux = { ...JSON.parse(new TextDecoder().decode(sB[FICHIER_SIGNATURE])), empreinte: empreinteArtefact(base()) };
    expect(verifierArtefact({ ...sA, [FICHIER_SIGNATURE]: octets(JSON.stringify(faux)) }, [bao.publique("modules-publication", 1)])).toEqual(refus);
  });

  it("[A-304] attaque 3 : un artefact modifié après la signature du coffre est refusé", async () => {
    const { bao, signataire } = monde();
    const a = await signataire("modules-publication").signerArtefact(base());
    a["module.js"] = octets("export default 666;");
    expect(verifierArtefact(a, [bao.publique("modules-publication", 1)])).toEqual(refus);
  });

  it("[A-304] attaque 2 : la production n'accepte que modules-publication ; la signature de recette est refusée, même avec un idCle de publication", async () => {
    const { bao, signataire } = monde();
    const production = [bao.publique("modules-publication", 1)];
    const deRecette = await signataire("modules-recette").signerArtefact(base());
    expect(verifierArtefact(deRecette, production)).toEqual(refus);
    const relabellise = { ...JSON.parse(new TextDecoder().decode(deRecette[FICHIER_SIGNATURE])), idCle: "modules-publication:v1" };
    expect(verifierArtefact({ ...deRecette, [FICHIER_SIGNATURE]: octets(JSON.stringify(relabellise)) }, production)).toEqual(refus);
    expect(verifierArtefact(deRecette, [...production, bao.publique("modules-recette", 1)]).ok).toBe(true);
  });

  it("[C-018] attaque 4 : une signature de recette ne devient pas une signature de publication sans nouvelle signature", async () => {
    const { bao, signataire } = monde();
    const deRecette = await signataire("modules-recette").signerArtefact(base());
    const publiee = await signataire("modules-publication").signerArtefact(deRecette);
    expect(JSON.parse(new TextDecoder().decode(publiee[FICHIER_SIGNATURE]))).toMatchObject({ idCle: "modules-publication:v1" });
    expect(verifierArtefact(publiee, [bao.publique("modules-publication", 1)]).ok).toBe(true);
    expect(verifierArtefact(deRecette, [bao.publique("modules-publication", 1)])).toEqual(refus);
  });

  it("[C-018] après rotation, une signature de l'ancienne version reste vérifiable pendant le chevauchement, puis refusée", async () => {
    const { bao, signataire } = monde();
    const ancienne = await signataire("modules-publication").signerArtefact(base());
    bao.tourner("modules-publication");
    const nouvelle = await signataire("modules-publication").signerArtefact(base());
    expect(JSON.parse(new TextDecoder().decode(nouvelle[FICHIER_SIGNATURE]))).toMatchObject({ idCle: "modules-publication:v2" });
    const v1 = bao.publique("modules-publication", 1), v2 = bao.publique("modules-publication", 2);
    // Chevauchement : les deux versions sont épinglées.
    expect(verifierArtefact(ancienne, [v1, v2]).ok).toBe(true);
    expect(verifierArtefact(nouvelle, [v1, v2]).ok).toBe(true);
    // Fin du chevauchement : v1 est retirée de la liste (ou révoquée).
    expect(verifierArtefact(ancienne, [v2])).toEqual(refus);
    expect(verifierArtefact(ancienne, [{ ...v1, revoquee: true }, v2])).toEqual(refus);
    expect(verifierArtefact(nouvelle, [v2]).ok).toBe(true);
  });

  it("[A-304] attaque 4 (rejeu) : la signature d'une version de clé ne vaut pas sous l'identifiant d'une autre version", async () => {
    const { bao, signataire } = monde();
    bao.tourner("modules-publication");
    const v2 = await signataire("modules-publication").signerArtefact(base());
    const sous = { ...JSON.parse(new TextDecoder().decode(v2[FICHIER_SIGNATURE])), idCle: "modules-publication:v1" };
    const liste = [bao.publique("modules-publication", 1), bao.publique("modules-publication", 2)];
    expect(verifierArtefact({ ...v2, [FICHIER_SIGNATURE]: octets(JSON.stringify(sous)) }, liste)).toEqual(refus);
  });

  it("[C-018] attaque 5 : coffre scellé ou injoignable → erreur du coffre, aucun artefact signé, aucun repli local", async () => {
    const { bao, signataire } = monde();
    bao.etat.scelle = true;
    await expect(signataire("modules-publication").signerArtefact(base())).rejects.toMatchObject({ code: "coffre_scelle" });
    bao.etat.scelle = false;
    bao.etat.coupe = true;
    const e = await signataire("modules-publication").signerArtefact(base()).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurCoffre);
    expect((e as ErreurCoffre).code).toBe("coffre_indisponible");
    expect(String((e as Error).message)).not.toMatch(/jeton-/);
  });

  it("[C-018] attaque 5 : une réponse truquée du coffre (forme, version, longueur, autre clé) n'est jamais écrite dans signature.json", async () => {
    const { bao, signataire } = monde();
    const longue = Buffer.alloc(64, 1).toString("base64");
    for (const signature of [undefined, 42, "", "pas-vault", "vault:v0:" + longue, "vault:v1:", "vault:v1:" + Buffer.alloc(10).toString("base64"), "vault:v1:" + longue + "\n", "vault:v1:!!!"]) {
      bao.etat.corpsFixe = { data: { signature } };
      await expect(signataire("modules-publication").signerArtefact(base()), String(signature)).rejects.toMatchObject({ code: "coffre_indisponible" });
    }
    bao.etat.corpsFixe = { data: {} };
    await expect(signataire("modules-publication").signerArtefact(base())).rejects.toMatchObject({ code: "coffre_indisponible" });
  });

  it("[C-018] le jeton de publication ne signe qu'avec modules-publication ; toute autre clé est refusée avant l'appel", async () => {
    const { bao } = monde();
    const e = createHash("sha256").update("x").digest("hex");
    const o = { url: URL_BAO, jeton: bao.jeton("publication"), fetch: bao.fetch };
    for (const nom of ["modules-signature", "exports-signature", "cli-x", "../keys/x", "modules-publication/../x", "modules-recette?x", ""]) {
      expect(() => creerSignataireOpenBao(o, nom as never), nom).toThrow();
    }
    const sans = creerSignataireOpenBao({ ...o, jeton: bao.jeton("api") }, "modules-publication");
    await expect(sans.signer(e)).rejects.toMatchObject({ code: "refuse" });
    // Le jeton de publication ne peut pas signer pour la recette (ni l'inverse).
    await expect(creerSignataireOpenBao(o, "modules-recette").signer(e)).rejects.toMatchObject({ code: "refuse" });
  });

  it("[C-018] la politique publication ne lit aucune valeur du coffre ni aucune autre clé", () => {
    const hcl = racine("ops/socle/openbao/politiques/publication.hcl");
    expect(droitsPublication()).toEqual([{ chemin: "transit/sign/modules-publication", capacites: ["update"] }]);
    // Le fichier ne contient que ce bloc (hors commentaires) : aucun joker, aucun autre mot-clé.
    const code = hcl.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").trim();
    expect(code).toBe('path "transit/sign/modules-publication" {\n  capabilities = ["update"]\n}');
    expect(code).not.toMatch(/\*|\+|sudo|"read"|"list"|"delete"|"create"|keys\/|export|config|verify/);
  });

  it("[C-018] initialiser.sh crée modules-publication et modules-recette (ed25519, exportable=false), pose la politique publication et un jeton à elle seule", () => {
    const sh = racine("ops/socle/openbao/initialiser.sh");
    expect(sh).toContain("bao write -f transit/keys/modules-publication type=ed25519 exportable=false");
    expect(sh).toContain("bao write -f transit/keys/modules-recette type=ed25519 exportable=false");
    expect(sh).toContain('bao policy write publication - <"$dossier/politiques/publication.hcl"');
    expect(sh).toContain("-policy=publication -no-default-policy");
    expect(sh).toContain("PUBLICATION=");
    expect(sh).not.toMatch(/allow_plaintext_backup|transit\/export|transit\/keys\/modules-(publication|recette)\/config/);
  });
});
