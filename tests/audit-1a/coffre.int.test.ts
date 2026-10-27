import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, writeSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../scripts/garde-compose.ts";
import { creerCoffre, ErreurCoffre, type OptionsBao } from "../../apps/api/src/coffre/coffre.ts";
import { creerClesEchanges } from "../../apps/api/src/coffre/cles-echanges.ts";
import { creerEnveloppe, type Enveloppe } from "../../apps/api/src/coffre/enveloppe.ts";
import { creerSignature } from "../../apps/api/src/coffre/signature.ts";
import { creerLecteurSecretsOpenBao } from "../../apps/api/src/secrets-openbao.ts";

// Porte du lot 1-A (T1A-19, partie A) : coffre OpenBao en boîte noire. Un VRAI OpenBao en mode serveur (raft), même image et même
// configuration que le socle, initialisé comme ops/socle/openbao/initialiser.sh (montages, clé de signature, les 7 politiques du dépôt).
// L'OpenBao du socle n'est pas touché : il ne s'initialise qu'une fois, et l'essai des sauvegardes s'en sert.
// Jeton racine, part de déverrouillage et valeurs : générés au lancement, jamais écrits dans un fichier versionné ni affichés.
const racine = (chemin: string) => fileURLToPath(new URL(`../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const IMAGE = (lireYaml(readFileSync(racine("ops/socle/compose.openbao.yml"), "utf8")) as unknown as { services: { openbao: { image: string } } }).services.openbao.image;
const ROLES = ["api", "courtier", "equipe", "signature", "echanges", "secours", "passerelle"] as const;
type Role = (typeof ROLES)[number];
const A = "3a2b3c4d-0000-4a00-8a00-00000000000a";
const B = "3a2b3c4d-0000-4b00-8b00-00000000000b";
const marqueur = (nom: string) => `MARQUEUR-${nom}-${randomBytes(10).toString("hex")}`;
const VALEUR_A = marqueur("valeur-a");
const VALEUR_B = marqueur("valeur-b");
const MAITRE = `sk-TEST-NE-PAS-UTILISER-${randomBytes(10).toString("hex")}`;
const FOURNISSEUR = `TEST-NE-PAS-UTILISER-${randomBytes(10).toString("hex")}`;
const TECHNIQUE = marqueur("technique");

afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") writeSync(2, `ECHEC ${ctx.task.name}\n${(ctx.task.result.errors ?? []).map((e) => e.message).join("\n")}\n`);
});

const lances: string[] = [];
afterAll(() => {
  for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ }
});

let url = "";
let jetonRacine = "";
const jetons = new Map<Role, string>();
const opts = (role: Role): OptionsBao => ({ url, jeton: jetons.get(role) ?? "" });
let refA = "";
let refB = "";
let envA: Enveloppe;
let envB: Enveloppe;
let secretHmac = "";
let kidHmac = "";

async function http(jeton: string, methode: string, chemin: string, corps?: unknown) {
  const r = await fetch(`${url}/v1/${chemin}`, { method: methode, headers: { "X-Vault-Token": jeton, ...(corps === undefined ? {} : { "Content-Type": "application/json" }) }, ...(corps === undefined ? {} : { body: JSON.stringify(corps) }) });
  const octets = Buffer.from(await r.arrayBuffer());
  return { statut: r.status, texte: octets.toString("latin1") };
}
async function admin(methode: string, chemin: string, corps?: unknown): Promise<Record<string, unknown>> {
  for (let n = 0; ; n++) {
    const r = await http(jetonRacine, methode, chemin, corps);
    if (r.statut < 300) return r.texte ? (JSON.parse(r.texte) as Record<string, unknown>) : {};
    // Un montage KV v2 refuse les écritures un instant après sa création : on réessaie (préparation seulement).
    if (n > 60) throw new Error(`administration refusée (${r.statut}) sur ${chemin}`);
    await new Promise((ok) => setTimeout(ok, 500));
  }
}

beforeAll(async () => {
  const id = docker("run", "-d", "--rm", "-v", `${racine("ops/socle/openbao")}:/openbao/config:ro`, IMAGE, "server");
  lances.push(id);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  url = `http://${ip}:8200`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/v1/sys/health`)).status === 501) break; } catch { /* démarrage */ }
    if (i > 120) throw new Error("OpenBao d'essai non démarré");
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const init = (await (await fetch(`${url}/v1/sys/init`, { method: "POST", body: JSON.stringify({ secret_shares: 1, secret_threshold: 1 }) })).json()) as { keys_base64: string[]; root_token: string };
  jetonRacine = init.root_token;
  for (let n = 0; ; n++) {
    const sante = await fetch(`${url}/v1/sys/health`).then((r) => r.status, () => 0);
    if (sante === 200) break;
    if (sante === 503) await fetch(`${url}/v1/sys/unseal`, { method: "POST", body: JSON.stringify({ key: init.keys_base64[0] }) }).catch(() => undefined);
    if (n > 120) throw new Error("OpenBao d'essai non déverrouillé");
    await new Promise((ok) => setTimeout(ok, 500));
  }
  // Montages du socle (initialiser.sh) plus passerelle/ (C-598 d), lu par la politique passerelle.
  await admin("POST", "sys/mounts/clients", { type: "kv", options: { version: "2" } });
  await admin("POST", "sys/mounts/transit", { type: "transit" });
  await admin("POST", "sys/mounts/technique", { type: "kv", options: { version: "2" } });
  await admin("POST", "sys/mounts/passerelle", { type: "kv", options: { version: "2" } });
  await admin("POST", "transit/keys/modules-signature", { type: "ed25519", exportable: false });
  await admin("POST", "passerelle/data/maitre", { data: { cle: MAITRE } });
  await admin("POST", "passerelle/data/fournisseurs", { data: { FOURNISSEUR_FAUX_CLE: FOURNISSEUR } });
  await admin("POST", "technique/data/essai/jeton", { data: { valeur: TECHNIQUE } });
  for (const r of ROLES) {
    await admin("POST", `sys/policies/acl/${r}`, { policy: readFileSync(racine(`ops/socle/openbao/politiques/${r}.hcl`), "utf8") });
    const t = (await admin("POST", "auth/token/create", { policies: [r], no_default_policy: true })) as { auth?: { client_token?: string } };
    jetons.set(r, t.auth?.client_token ?? "");
  }
  // Données des deux clients, rangées par le code de l'API avec le jeton api (comme en production).
  const coffreApi = creerCoffre(opts("api"));
  refA = await coffreApi.rangerIdentifiant(A, "essai", VALEUR_A);
  refB = await coffreApi.rangerIdentifiant(B, "essai", VALEUR_B);
  const enveloppe = creerEnveloppe(opts("api"));
  await enveloppe.creerCleClient(A);
  await enveloppe.creerCleClient(B);
  envA = await enveloppe.chiffrer(A, Buffer.from(VALEUR_A));
  envB = await enveloppe.chiffrer(B, Buffer.from(VALEUR_B));
  const hmac = await creerClesEchanges(opts("echanges")).tourner("c1", "emission");
  secretHmac = hmac.secret.toString("base64");
  kidHmac = hmac.kid;
}, 180_000);

const valeurs = () => [VALEUR_A, VALEUR_B, MAITRE, FOURNISSEUR, TECHNIQUE, secretHmac];
const chemin = (ref: string) => ref.slice("bao:clients/".length);
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ErreurCoffre ? e.code : "autre"));

describe("audit 1-A · coffre OpenBao", () => {
  it("[A-005] @isolation matrice des droits : chaque jeton de rôle n'obtient que ce que sa politique déclare, et aucune réponse refusée ne porte une valeur", async () => {
    const pA = chemin(refA);
    const pB = chemin(refB);
    const demandes: { quoi: string; methode: string; chemin: string; corps?: unknown; permis: Role[] }[] = [
      { quoi: "lire la valeur de A", methode: "GET", chemin: `clients/data/${pA}`, permis: ["courtier"] },
      { quoi: "lire la valeur de B", methode: "GET", chemin: `clients/data/${pB}`, permis: ["courtier"] },
      { quoi: "écrire un identifiant chez B", methode: "POST", chemin: `clients/data/${B}/${randomUUID()}`, corps: { data: { nom: "intrus", valeur: "TEST-NE-PAS-UTILISER-intrus" } }, permis: ["api"] },
      { quoi: "lire l'état de A", methode: "GET", chemin: `clients/metadata/${pA}`, permis: ["api", "equipe"] },
      { quoi: "lister les identifiants de A", methode: "LIST", chemin: `clients/metadata/${A}`, permis: [] },
      { quoi: "lister les clients", methode: "LIST", chemin: "clients/metadata", permis: [] },
      { quoi: "lire une ancienne version de B", methode: "GET", chemin: `clients/data/${pB}?version=1`, permis: ["courtier"] },
      { quoi: "supprimer la valeur de B", methode: "DELETE", chemin: `clients/data/${pB}`, permis: [] },
      { quoi: "détruire les versions de B", methode: "POST", chemin: `clients/destroy/${pB}`, corps: { versions: [1] }, permis: [] },
      { quoi: "effacer l'identifiant de B", methode: "DELETE", chemin: `clients/metadata/${pB}`, permis: [] },
      { quoi: "lire la clé HMAC c1", methode: "GET", chemin: `technique/data/echanges/c1/${kidHmac}`, permis: ["echanges"] },
      { quoi: "lister les clés HMAC c1", methode: "LIST", chemin: "technique/metadata/echanges/c1", permis: ["echanges"] },
      { quoi: "lire un secret technique", methode: "GET", chemin: "technique/data/essai/jeton", permis: [] },
      { quoi: "lire la clé maîtresse de la passerelle", methode: "GET", chemin: "passerelle/data/maitre", permis: ["passerelle"] },
      { quoi: "lire les clés des fournisseurs", methode: "GET", chemin: "passerelle/data/fournisseurs", permis: ["passerelle"] },
      { quoi: "écrire la clé maîtresse", methode: "POST", chemin: "passerelle/data/maitre", corps: { data: { cle: "TEST-NE-PAS-UTILISER-x" } }, permis: [] },
      { quoi: "exporter la clé transit de A", methode: "GET", chemin: `transit/export/encryption-key/cli-${A}`, permis: [] },
      { quoi: "sauvegarder la clé transit de A", methode: "GET", chemin: `transit/backup/cli-${A}`, permis: [] },
      { quoi: "lire la clé transit de A", methode: "GET", chemin: `transit/keys/cli-${A}`, permis: [] },
      { quoi: "déchiffrer la clé de données de A", methode: "POST", chemin: `transit/decrypt/cli-${A}`, corps: { ciphertext: envA.cleChiffree }, permis: ["api"] },
      { quoi: "rechiffrer la clé de données de A", methode: "POST", chemin: `transit/rewrap/cli-${A}`, corps: { ciphertext: envA.cleChiffree }, permis: [] },
      { quoi: "chiffrer avec la clé de A", methode: "POST", chemin: `transit/encrypt/cli-${A}`, corps: { plaintext: Buffer.from("x").toString("base64") }, permis: [] },
      { quoi: "exporter la clé de signature", methode: "GET", chemin: "transit/export/signing-key/modules-signature", permis: [] },
      { quoi: "signer un module", methode: "POST", chemin: "transit/sign/modules-signature", corps: { input: Buffer.from("x").toString("base64") }, permis: ["signature"] },
      { quoi: "prendre un instantané raft", methode: "GET", chemin: "sys/storage/raft/snapshot", permis: ["secours"] },
      { quoi: "lister les politiques", methode: "LIST", chemin: "sys/policies/acl", permis: [] },
      { quoi: "écrire une politique", methode: "POST", chemin: "sys/policies/acl/intrus", corps: { policy: 'path "*" { capabilities = ["read"] }' }, permis: [] },
      { quoi: "créer un jeton", methode: "POST", chemin: "auth/token/create", corps: { policies: ["courtier"] }, permis: [] },
      { quoi: "lire les montages", methode: "GET", chemin: "sys/mounts", permis: [] },
      { quoi: "lire la journalisation d'audit", methode: "GET", chemin: "sys/audit", permis: [] },
    ];
    const ecarts: string[] = [];
    const fuites: string[] = [];
    for (const d of demandes) {
      for (const role of ROLES) {
        const r = await http(jetons.get(role) ?? "", d.methode, d.chemin, d.corps);
        const permis = d.permis.includes(role);
        if ((r.statut === 403) === permis) ecarts.push(`${role} · ${d.quoi} : ${r.statut} (${permis ? "permis" : "refus"} attendu)`);
        if (!permis) for (const v of valeurs()) if (v && r.texte.includes(v)) fuites.push(`${role} · ${d.quoi}`);
      }
    }
    expect(ecarts).toEqual([]);
    expect(fuites).toEqual([]);
  }, 120_000);

  it("[A-005] @isolation le jeton equipe ne lit aucune valeur : le code de l'API le refuse et l'état ne porte jamais la valeur", async () => {
    const equipe = creerCoffre(opts("equipe"));
    expect(await equipe.lireEtat(A, refA)).toMatchObject({ nom: "essai", etat: "present" });
    expect(await code(equipe.lireValeur(A, refA))).toBe("refuse");
    expect(await code(creerLecteurSecretsOpenBao(opts("equipe")).lire("essai/jeton"))).toBe("refuse");
    expect(await code(creerClesEchanges(opts("equipe")).cleActive("c1", "emission"))).toBe("refuse");
    expect(await code(creerEnveloppe(opts("equipe")).dechiffrer(A, envA))).toBe("refuse");
    expect(await code(creerSignature(opts("equipe")).signer(Buffer.from("x")))).toBe("refuse");
    const etat = await http(jetons.get("equipe") ?? "", "GET", `clients/metadata/${chemin(refA)}`);
    expect(etat.statut).toBe(200);
    for (const v of valeurs()) expect(etat.texte.includes(v), "valeur dans l'état").toBe(false);
  }, 60_000);

  it("[C-011] @isolation le courtier appelé pour A avec une référence de B, ou maquillée, ne rend jamais la valeur de B", async () => {
    let appels = 0;
    const compteur: typeof fetch = (entree, init) => {
      appels++;
      return fetch(entree, init);
    };
    const courtier = creerCoffre({ ...opts("courtier"), fetch: compteur });
    const uB = refB.split("/").pop() ?? "";
    const uA = refA.split("/").pop() ?? "";
    expect(await code(courtier.lireValeur(A, refB))).toBe("reference_etrangere");
    expect(appels, "aucun appel au coffre pour une référence étrangère").toBe(0);
    const maquillees = [
      `bao:clients/${A}/../${B}/${uB}`,
      `bao:clients/${A}/${uA}/../../${B}/${uB}`,
      `bao:clients/${A}%2F..%2F${B}/${uB}`,
      `bao:clients/${A}/${uB}?version=1`,
      `bao:clients/${B.toUpperCase()}/${uB}`,
      `bao:clients//${B}/${uB}`,
      ` bao:clients/${B}/${uB}`,
      `bao:transit/${B}/${uB}`,
    ];
    for (const ref of maquillees) {
      const r = await courtier.lireValeur(A, ref).then((v) => v, (e: unknown) => (e instanceof ErreurCoffre ? e.code : "autre"));
      expect(r, ref).not.toBe(VALEUR_B);
      expect(["reference_invalide", "reference_etrangere"], ref).toContain(r);
    }
    expect(appels).toBe(0);
    // La forme valide « A / identifiant de B » interroge le chemin de A, où rien n'existe : introuvable, jamais la valeur de B.
    expect(await code(courtier.lireValeur(A, `bao:clients/${A}/${uB}`))).toBe("introuvable");
    expect(await courtier.lireValeur(B, refB)).toBe(VALEUR_B);
    expect(await code(creerCoffre(opts("equipe")).lireEtat(A, refB))).toBe("reference_etrangere");
  }, 60_000);

  it("[C-012] @isolation l'enveloppe de B ne s'ouvre pas pour A, même en mêlant clé de données et chiffré des deux clients", async () => {
    const e = creerEnveloppe(opts("api"));
    expect((await e.dechiffrer(A, envA)).toString()).toBe(VALEUR_A);
    expect((await e.dechiffrer(B, envB)).toString()).toBe(VALEUR_B);
    const melanges: [string, string, Enveloppe][] = [
      ["A ouvre l'enveloppe de B", A, envB],
      ["A ouvre le chiffré de B avec sa propre clé de données", A, { ...envB, cleChiffree: envA.cleChiffree, version: envA.version }],
      ["B ouvre le chiffré de A avec la clé de données de B", B, { ...envA, cleChiffree: envB.cleChiffree, version: envB.version }],
      ["B ouvre l'enveloppe de A", B, envA],
    ];
    for (const [quoi, tenant, env] of melanges) {
      const r = await e.dechiffrer(tenant, env).then((o) => o.toString(), (x: unknown) => (x instanceof ErreurCoffre ? x.code : "autre"));
      expect(r, quoi).not.toBe(VALEUR_A);
      expect(r, quoi).not.toBe(VALEUR_B);
      expect(["dechiffrement_impossible", "requete_refusee", "refuse"], quoi).toContain(r);
    }
    // Détruire la clé de A n'atteint pas B.
    const C = randomUUID();
    await e.creerCleClient(C);
    const envC = await e.chiffrer(C, Buffer.from("à perdre"));
    await e.detruireCleClient(C, `detruire-${C}`);
    expect(await code(e.dechiffrer(C, envC))).not.toBe("ok");
    expect((await e.dechiffrer(B, envB)).toString()).toBe(VALEUR_B);
    // La confirmation d'un autre client ne détruit rien.
    expect(await code(e.detruireCleClient(B, `detruire-${A}`))).toBe("confirmation_absente");
    expect((await e.dechiffrer(B, envB)).toString()).toBe(VALEUR_B);
  }, 60_000);

  // En dernier : le coffre est scellé pour de bon.
  it("[C-011] OpenBao scellé n'ouvre aucun repli : chaque chemin du coffre échoue en coffre_scelle, sans valeur, et la passerelle refuse de démarrer", async () => {
    // Témoin avant scellement : la passerelle démarre avec le vrai OpenBao (faux « litellm » qui note seulement qu'il a été lancé).
    const dossier = mkdtempSync(join(tmpdir(), "audit-passerelle-"));
    const jeton = join(dossier, "jeton");
    writeFileSync(jeton, jetons.get("passerelle") ?? "", { mode: 0o600 });
    writeFileSync(join(dossier, "litellm"), '#!/bin/sh\ntouch "$TEMOIN"\n');
    chmodSync(join(dossier, "litellm"), 0o755);
    const demarrer = (temoin: string) =>
      new Promise<{ code: number | null; sortie: string }>((ok) => {
        const p = spawn("sh", [racine("ops/socle/litellm/demarrer.sh")], { env: { PATH: `${dossier}:${process.env.PATH ?? ""}`, BAO_ADDR: url, BAO_JETON_FICHIER: jeton, TEMOIN: temoin } });
        let sortie = "";
        p.stdout.on("data", (d: Buffer) => (sortie += d.toString()));
        p.stderr.on("data", (d: Buffer) => (sortie += d.toString()));
        p.on("close", (c) => ok({ code: c, sortie }));
      });
    const avant = await demarrer(join(dossier, "avant"));
    expect(avant.code, "témoin : la passerelle démarre quand le coffre est ouvert").toBe(0);
    expect(existsSync(join(dossier, "avant"))).toBe(true);

    await admin("PUT", "sys/seal");
    expect((await fetch(`${url}/v1/sys/health`)).status).toBe(503);
    const essais: [string, Promise<unknown>][] = [
      ["courtier lit A", creerCoffre(opts("courtier")).lireValeur(A, refA)],
      ["api range pour A", creerCoffre(opts("api")).rangerIdentifiant(A, "essai", "TEST-NE-PAS-UTILISER-scelle")],
      ["equipe lit l'état", creerCoffre(opts("equipe")).lireEtat(A, refA)],
      ["enveloppe chiffre", creerEnveloppe(opts("api")).chiffrer(A, Buffer.from("x"))],
      ["enveloppe déchiffre", creerEnveloppe(opts("api")).dechiffrer(A, envA)],
      ["clé HMAC active", creerClesEchanges(opts("echanges")).cleActive("c1", "emission")],
      ["signature", creerSignature(opts("signature")).signer(Buffer.from("x"))],
      ["secret technique", creerLecteurSecretsOpenBao(opts("passerelle")).lire("essai/jeton")],
    ];
    for (const [quoi, p] of essais) {
      const e = await p.then(() => undefined, (x: unknown) => x);
      expect(e, quoi).toBeInstanceOf(ErreurCoffre);
      expect((e as ErreurCoffre).code, quoi).toBe("coffre_scelle");
      for (const v of valeurs()) expect(String((e as Error).message).includes(v), quoi).toBe(false);
    }
    const apres = await demarrer(join(dossier, "apres"));
    expect(apres.code).not.toBe(0);
    expect(existsSync(join(dossier, "apres")), "LiteLLM lancé alors que le coffre est scellé").toBe(false);
    for (const v of valeurs()) expect(apres.sortie.includes(v)).toBe(false);
  }, 60_000);
});
