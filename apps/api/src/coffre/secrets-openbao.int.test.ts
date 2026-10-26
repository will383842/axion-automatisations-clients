import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import { creerFluxJournal, creerMasqueur } from "../plugins/journal.js";
import { creerLecteurSecretsOpenBao } from "../secrets-openbao.js";
import { construireServeur } from "../serveur.js";
import { ErreurCoffre } from "./coffre.js";

// Tests contre un VRAI OpenBao lancé par le test (conteneur jetable de la même image que le socle, mode dev admis pour les droits).
// Le jeton racine et la valeur de secret sont générés au lancement, jamais écrits dans un fichier ni affichés.
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
  const racine = `TEST-NE-PAS-UTILISER-${randomBytes(12).toString("hex")}`;
  const id = docker("run", "-d", "--rm", "-e", `BAO_DEV_ROOT_TOKEN_ID=${racine}`, "-e", "BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200", compose.services.openbao.image, "server", "-dev");
  lances.push(id);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  const url = `http://${ip}:8200`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/v1/sys/health`)).status === 200) break; } catch { /* démarrage */ }
    if (i > 60) throw new Error("OpenBao de test non démarré");
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const marqueur = `MARQUEUR-${randomBytes(12).toString("hex")}`;
  await admin(url, racine, "POST", "sys/mounts/technique", { type: "kv", options: { version: "2" } });
  await admin(url, racine, "POST", "technique/data/essai/jeton", { data: { valeur: marqueur } });
  await admin(url, racine, "POST", "sys/policies/acl/lecteur-essai", { policy: 'path "technique/data/essai/*" { capabilities = ["read"] }' });
  await admin(url, racine, "POST", "sys/policies/acl/equipe", { policy: readFileSync(racineDepot("ops/socle/openbao/politiques/equipe.hcl"), "utf8") });
  const jeton = async (politique: string) => ((await admin(url, racine, "POST", "auth/token/create", { policies: [politique], no_default_policy: true })) as { auth: { client_token: string } }).auth.client_token;
  return { url, marqueur, jetonLecteur: await jeton("lecteur-essai"), jetonEquipe: await jeton("equipe") };
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
