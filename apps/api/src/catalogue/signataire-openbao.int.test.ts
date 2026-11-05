import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import { type ClePublique } from "../../../../packages/sdk-module/src/emballage/cles-publiques.ts";
import { empreinteArtefact } from "../../../../packages/sdk-module/src/emballage/signer.ts";
import { verifierArtefact } from "../../../../packages/sdk-module/src/emballage/verifier.ts";
import { appeler, type OptionsBao } from "../coffre/coffre.js";
import { journalEchecs } from "../provisionnement/journal-echecs.js";
import { creerSignataireOpenBao } from "./signataire-openbao.js";

journalEchecs(import.meta.url);

// Essai contre un VRAI OpenBao jetable (même image que le socle), pour la CI socle-integration. Jetons générés au lancement, jamais affichés.
const racineDepot = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const compose = lireYaml(readFileSync(racineDepot("ops/socle/compose.openbao.yml"), "utf8")) as unknown as { services: { openbao: { image: string } } };
const lances: string[] = [];
afterAll(() => { for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ } });

async function admin(o: OptionsBao, methode: string, chemin: string, corps?: unknown): Promise<unknown> {
  const r = await fetch(`${o.url}/v1/${chemin}`, { method: methode, headers: { "X-Vault-Token": o.jeton, "Content-Type": "application/json" }, ...(corps === undefined ? {} : { body: JSON.stringify(corps) }) });
  if (r.status >= 300) throw new Error(`administration refusée (${r.status}) sur ${chemin}`);
  const texte = await r.text();
  return texte ? JSON.parse(texte) : undefined;
}

async function lancer(): Promise<{ racine: OptionsBao; publication: OptionsBao }> {
  const jetonRacine = `TEST-NE-PAS-UTILISER-${randomBytes(12).toString("hex")}`;
  const id = docker("run", "-d", "--rm", "-e", `BAO_DEV_ROOT_TOKEN_ID=${jetonRacine}`, "-e", "BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200", compose.services.openbao.image, "server", "-dev");
  lances.push(id);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  const url = `http://${ip}:8200`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/v1/sys/health`)).status === 200) break; } catch { /* démarrage */ }
    if (i > 60) throw new Error("OpenBao de test non démarré");
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const racine: OptionsBao = { url, jeton: jetonRacine };
  await admin(racine, "POST", "sys/mounts/transit", { type: "transit" });
  for (const cle of ["modules-publication", "modules-recette"]) await admin(racine, "POST", `transit/keys/${cle}`, { type: "ed25519", exportable: false });
  await admin(racine, "POST", "sys/policies/acl/publication", { policy: readFileSync(racineDepot("ops/socle/openbao/politiques/publication.hcl"), "utf8") });
  const r = (await admin(racine, "POST", "auth/token/create", { policies: ["publication"], no_default_policy: true })) as { auth: { client_token: string } };
  return { racine, publication: { url, jeton: r.auth.client_token } };
}

async function clePublique(racine: OptionsBao, nom: string, version: number): Promise<ClePublique> {
  const d = (await admin(racine, "GET", `transit/keys/${nom}`)) as { data: { keys: Record<string, { public_key: string }> } };
  const brut = Buffer.from(d.data.keys[String(version)]?.public_key ?? "", "base64");
  // SPKI Ed25519 = préfixe fixe de 12 octets + clé brute de 32 octets.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), brut]);
  return { idCle: `${nom}:v${version}`, publique: `-----BEGIN PUBLIC KEY-----\n${spki.toString("base64")}\n-----END PUBLIC KEY-----\n` };
}
const octets = (t: string) => new TextEncoder().encode(t);
const base = () => ({ "module.js": octets("export default 1;"), "manifest.json": octets('{"nom":"demo"}') });

describe("OpenBao réel : signature de production des modules", () => {
  it("[C-018] la clé modules-publication n'est pas exportable (demande d'export refusée par OpenBao)", async () => {
    const { racine } = await lancer();
    for (const cle of ["modules-publication", "modules-recette"]) {
      const e = await appeler(racine, "GET", `transit/export/signing-key/${cle}/1`).then(() => undefined, (x: unknown) => x);
      expect(e, cle).toBeDefined();
      const d = (await admin(racine, "GET", `transit/keys/${cle}`)) as { data: { exportable: boolean; type: string; allow_plaintext_backup: boolean } };
      expect(d.data).toMatchObject({ exportable: false, type: "ed25519", allow_plaintext_backup: false });
    }
  });

  it("[C-018] le jeton publication signe avec modules-publication et n'a aucun autre droit (autre clé, configuration, export, lecture)", async () => {
    const { racine, publication } = await lancer();
    const s = await creerSignataireOpenBao(publication, "modules-publication").signerArtefact(base());
    expect(verifierArtefact(s, [await clePublique(racine, "modules-publication", 1)]).ok).toBe(true);
    expect(empreinteArtefact(s)).toBe(empreinteArtefact(base()));
    for (const [methode, chemin, corps] of [
      ["POST", "transit/sign/modules-recette", { input: "YQ==" }],
      ["POST", "transit/keys/modules-publication/config", { exportable: true }],
      ["POST", "transit/keys/modules-publication/rotate", {}],
      ["GET", "transit/keys/modules-publication", undefined],
      ["GET", "transit/export/signing-key/modules-publication/1", undefined],
      ["POST", "transit/verify/modules-publication", { input: "YQ==", signature: "vault:v1:AA==" }],
      ["GET", "clients/data/x", undefined],
    ] as const) {
      const e = await appeler(publication, methode, chemin, corps).then(() => undefined, (x: unknown) => x);
      expect(e, `${methode} ${chemin}`).toMatchObject({ code: "refuse" });
    }
  });

  it("[C-018] un module signé par la recette n'est pas accepté par la liste de production du coffre réel", async () => {
    const { racine, publication } = await lancer();
    const s = await creerSignataireOpenBao(publication, "modules-publication").signerArtefact(base());
    const recetteCle = await clePublique(racine, "modules-recette", 1);
    expect(verifierArtefact(s, [recetteCle])).toEqual({ ok: false, code: "module_non_signe" });
  });
});
