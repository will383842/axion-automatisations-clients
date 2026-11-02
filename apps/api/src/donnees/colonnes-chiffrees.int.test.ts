import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import { appeler, ErreurCoffre, type OptionsBao } from "../coffre/coffre.js";
import { creerEnveloppe } from "../coffre/enveloppe.js";
import { creerFichiersClient, type PortFichiers } from "../stockage/fichiers-client.js";
import { creerColonnesChiffrees } from "./colonnes-chiffrees.js";

// Contre un VRAI OpenBao lancé par le test (même image que le socle), avec la politique api du dépôt. Jetons et clés générés au lancement.
const racineDepot = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const compose = lireYaml(readFileSync(racineDepot("ops/socle/compose.openbao.yml"), "utf8")) as unknown as { services: { openbao: { image: string } } };
const lances: string[] = [];
afterAll(() => { for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ } });

async function lancer(): Promise<OptionsBao> {
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
  const admin = (corps: unknown, chemin: string) => fetch(`${url}/v1/${chemin}`, { method: "POST", headers: { "X-Vault-Token": racine, "Content-Type": "application/json" }, body: JSON.stringify(corps) });
  await admin({ type: "transit" }, "sys/mounts/transit");
  await admin({ policy: readFileSync(racineDepot("ops/socle/openbao/politiques/api.hcl"), "utf8") }, "sys/policies/acl/api");
  const r = (await (await admin({ policies: ["api"], no_default_policy: true }, "auth/token/create")).json()) as { auth: { client_token: string } };
  return { url, jeton: r.auth.client_token };
}

describe("colonnes et fichiers chiffrés, OpenBao réel", () => {
  it("[A-245] après destruction de la clé, champs et fichiers sont illisibles, y compris avec un cache chaud", async () => {
    const bao = await lancer();
    const env = creerEnveloppe(bao);
    const colonnes = creerColonnesChiffrees(bao);
    const objets = new Map<string, Uint8Array>();
    const stockage: PortFichiers = { deposer: async (t, c, o) => void objets.set(`${t}/${c}`, o), lire: async (t, c) => objets.get(`${t}/${c}`) };
    const fichiers = creerFichiersClient({ stockage, enveloppe: env });
    const A = randomUUID();
    const B = randomUUID();
    for (const t of [A, B]) {
      await env.creerCleClient(t);
      await appeler(bao, "POST", `transit/keys/cli-${t}-recherche`, { type: "hmac", exportable: false });
    }
    const champ = await colonnes.chiffrerChamp(A, "essai@exemple.fr");
    const champB = await colonnes.chiffrerChamp(B, "essai@exemple.fr");
    await fichiers.deposerFichier(A, "exports/a.bin", Buffer.from("fichier fictif"));
    expect(await colonnes.empreinteRecherche(A, "essai@exemple.fr")).not.toBe(await colonnes.empreinteRecherche(B, "essai@exemple.fr"));
    expect(await colonnes.dechiffrerChamp(A, champ)).toBe("essai@exemple.fr"); // cache chaud
    await colonnes.pivoterCle(A);
    expect(await colonnes.dechiffrerChamp(A, champ)).toBe("essai@exemple.fr");
    await expect(colonnes.dechiffrerChamp(B, champ)).rejects.toBeInstanceOf(ErreurCoffre);
    await env.detruireCleClient(A, `detruire-${A}`); // client fictif créé par ce test
    await expect(colonnes.dechiffrerChamp(A, champ)).rejects.toBeInstanceOf(ErreurCoffre);
    await expect(fichiers.lireFichier(A, "exports/a.bin")).rejects.toBeInstanceOf(ErreurCoffre);
    expect(await colonnes.dechiffrerChamp(B, champB)).toBe("essai@exemple.fr");
  }, 120_000);
});
