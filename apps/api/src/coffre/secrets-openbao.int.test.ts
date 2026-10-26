import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import { creerFluxJournal, creerMasqueur } from "../plugins/journal.js";
import { creerLecteurSecretsOpenBao } from "../secrets-openbao.js";
import { construireServeur } from "../serveur.js";
import { creerCoffre, ErreurCoffre, type OptionsBao } from "./coffre.js";
import { creerEnveloppe } from "./enveloppe.js";

// Tests contre un VRAI OpenBao lancé par le test : conteneur jetable de la même image et de la même configuration que le socle
// (mode serveur, stockage raft, une seule part de déverrouillage), jamais en mode dev. Les vraies politiques api, courtier et equipe sont chargées.
// Le jeton racine, la part de déverrouillage et les valeurs de secret sont générés au lancement, jamais écrits dans un fichier ni affichés.
const racineDepot = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const compose = lireYaml(readFileSync(racineDepot("ops/socle/compose.openbao.yml"), "utf8")) as unknown as { services: { openbao: { image: string } } };
const lances: string[] = [];
afterAll(() => { for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ } });

async function admin(url: string, jeton: string, methode: string, chemin: string, corps: unknown): Promise<unknown> {
  const r = await fetch(`${url}/v1/${chemin}`, { method: methode, headers: { "X-Vault-Token": jeton, "Content-Type": "application/json" }, body: JSON.stringify(corps) });
  if (r.status >= 300) throw new Error(`administration refusée (${r.status}) sur ${chemin}`);
  const texte = await r.text();
  return texte ? JSON.parse(texte) : undefined;
}

async function preparer() {
  const id = docker("run", "-d", "--rm", "-v", `${racineDepot("ops/socle/openbao")}:/openbao/config:ro`, compose.services.openbao.image, "server");
  lances.push(id);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  const url = `http://${ip}:8200`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/v1/sys/health`)).status === 501) break; } catch { /* démarrage */ }
    if (i > 60) throw new Error("OpenBao de test non démarré");
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const init = (await admin(url, "", "POST", "sys/init", { secret_shares: 1, secret_threshold: 1 })) as { keys_base64: string[]; root_token: string };
  const racine = init.root_token;
  for (let n = 0; ; n++) {
    try {
      const sante = (await fetch(`${url}/v1/sys/health`)).status;
      if (sante === 200) break;
      if (sante === 503) await admin(url, "", "POST", "sys/unseal", { key: init.keys_base64[0] });
    } catch { /* attente */ }
    if (n > 60) throw new Error("OpenBao de test non déverrouillé");
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const marqueur = `MARQUEUR-${randomBytes(12).toString("hex")}`;
  for (const [montage, type, options] of [["technique", "kv", { version: "2" }], ["clients", "kv", { version: "2" }], ["transit", "transit", {}]] as const) {
    await admin(url, racine, "POST", `sys/mounts/${montage}`, { type, options });
  }
  await admin(url, racine, "POST", "technique/data/essai/jeton", { data: { valeur: marqueur } });
  await admin(url, racine, "POST", "sys/policies/acl/lecteur-essai", { policy: 'path "technique/data/essai/*" { capabilities = ["read"] }' });
  for (const r of ["api", "courtier", "equipe"]) await admin(url, racine, "POST", `sys/policies/acl/${r}`, { policy: readFileSync(racineDepot(`ops/socle/openbao/politiques/${r}.hcl`), "utf8") });
  const jeton = async (politique: string): Promise<OptionsBao> => ({ url, jeton: ((await admin(url, racine, "POST", "auth/token/create", { policies: [politique], no_default_policy: true })) as { auth: { client_token: string } }).auth.client_token });
  return { url, racine, marqueur, jeton, jetonLecteur: (await jeton("lecteur-essai")).jeton, jetonEquipe: (await jeton("equipe")).jeton };
}

describe("OpenBao réel : lecteur de secrets et journal", () => {
  it("[C-011] le jeton autorisé lit la valeur, le jeton equipe reçoit un refus", async () => {
    const bao = await preparer();
    expect(await creerLecteurSecretsOpenBao({ url: bao.url, jeton: bao.jetonLecteur }).lire("essai/jeton")).toBe(bao.marqueur);
    const e = await creerLecteurSecretsOpenBao({ url: bao.url, jeton: bao.jetonEquipe }).lire("essai/jeton").then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurCoffre);
    expect((e as ErreurCoffre).code).toBe("refuse");
    const absent = await creerLecteurSecretsOpenBao({ url: bao.url, jeton: bao.jetonLecteur }).lire("essai/absent").then(() => undefined, (x: unknown) => x);
    expect((absent as ErreurCoffre).code).toBe("introuvable");
  }, 60_000);

  it("[C-011] coffre scellé réel (PUT sys/seal) → coffre_scelle, sans valeur rendue ni valeur dans le journal", async () => {
    const bao = await preparer();
    const masqueur = creerMasqueur();
    const lecteur = creerLecteurSecretsOpenBao({ url: bao.url, jeton: bao.jetonLecteur, masqueur });
    expect(await lecteur.lire("essai/jeton")).toBe(bao.marqueur);
    await admin(bao.url, bao.racine, "PUT", "sys/seal", {});
    const lignes: string[] = [];
    const serveur = construireServeur({ journal: creerFluxJournal(masqueur, (l) => lignes.push(l)) });
    serveur.get("/lire", async () => lecteur.lire("essai/jeton"));
    const reponse = await serveur.inject({ method: "GET", url: "/lire" });
    await serveur.close();
    const e = await lecteur.lire("essai/jeton").then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurCoffre);
    expect((e as ErreurCoffre).code).toBe("coffre_scelle");
    expect(reponse.statusCode).toBeGreaterThanOrEqual(500);
    expect(`${reponse.body}${lignes.join("")}`).not.toContain(bao.marqueur);
  }, 60_000);

  it("[C-011] la valeur se relit avec le jeton courtier et seulement avec lui", async () => {
    const bao = await preparer();
    const tenant = randomUUID();
    const reference = await creerCoffre(await bao.jeton("api")).rangerIdentifiant(tenant, "essai", bao.marqueur);
    expect(await creerCoffre(await bao.jeton("courtier")).lireValeur(tenant, reference)).toBe(bao.marqueur);
    for (const role of ["api", "equipe"]) {
      await expect(creerCoffre(await bao.jeton(role)).lireValeur(tenant, reference)).rejects.toMatchObject({ code: "refuse" });
    }
  }, 60_000);

  it("[A-005] @isolation le jeton equipe lit l'état d'un identifiant du client et reçoit 403 sur la valeur", async () => {
    const bao = await preparer();
    const tenant = randomUUID();
    const reference = await creerCoffre(await bao.jeton("api")).rangerIdentifiant(tenant, "essai", bao.marqueur);
    const equipe = creerCoffre(await bao.jeton("equipe"));
    expect(await equipe.lireEtat(tenant, reference)).toMatchObject({ nom: "essai", etat: "present" });
    const e = await equipe.lireValeur(tenant, reference).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurCoffre);
    expect((e as ErreurCoffre).code).toBe("refuse");
    expect(String((e as Error).message)).not.toContain(bao.marqueur);
  }, 60_000);

  it("[C-012] après detruireCleClient, le déchiffrement échoue pour toujours", async () => {
    const bao = await preparer();
    const tenant = randomUUID();
    const e = creerEnveloppe(await bao.jeton("api"));
    await e.creerCleClient(tenant);
    const env = await e.chiffrer(tenant, Buffer.from("à perdre"));
    expect((await e.dechiffrer(tenant, env)).toString()).toBe("à perdre");
    await e.detruireCleClient(tenant, `detruire-${tenant}`);
    await expect(e.dechiffrer(tenant, env)).rejects.toBeInstanceOf(ErreurCoffre);
    await expect(e.chiffrer(tenant, Buffer.from("x"))).rejects.toBeInstanceOf(ErreurCoffre);
  }, 60_000);

  it("[A-005] le journal de l'API ne contient jamais la valeur lue dans le vrai OpenBao (marqueur unique cherché dans la sortie)", async () => {
    const bao = await preparer();
    const masqueur = creerMasqueur();
    const lecteur = creerLecteurSecretsOpenBao({ url: bao.url, jeton: bao.jetonLecteur, masqueur });
    const lignes: string[] = [];
    const serveur = construireServeur({ journal: creerFluxJournal(masqueur, (l) => lignes.push(l)) });
    serveur.get("/piege", async () => {
      throw new Error(`échec avec ${await lecteur.lire("essai/jeton")}`);
    });
    await serveur.inject({ method: "GET", url: "/piege" });
    await serveur.close();
    const sortie = lignes.join("");
    expect(sortie).toContain("erreur interne");
    expect(sortie).not.toContain(bao.marqueur);
  }, 60_000);
});
