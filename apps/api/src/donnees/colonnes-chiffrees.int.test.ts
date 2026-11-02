import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
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

// Écrit sur la sortie d'erreur : le rapport JSON de la CI avale console.log.
const trace = (m: string) => writeSync(2, `${m}\n`);

describe("colonnes et fichiers chiffrés, OpenBao réel", () => {
  it("[A-245] après destruction de la clé, champs et fichiers sont illisibles, y compris avec un cache chaud", async () => {
    let etape = "lancement";
    const debut = Date.now();
    const marquer = (e: string) => { etape = e; trace(`COLONNES-INT étape « ${e} » à ${Date.now() - debut} ms`); };
    try {
      const bao = await lancer();
      marquer("clés");
      const env = creerEnveloppe(bao);
      const colonnes = creerColonnesChiffrees(bao);
      const objets = new Map<string, Uint8Array>();
      const stockage: PortFichiers = { deposer: async (t, c, o) => void objets.set(`${t}/${c}`, o), lire: async (t, c) => objets.get(`${t}/${c}`) };
      const fichiers = creerFichiersClient({ stockage, enveloppe: env });
      const A = randomUUID();
      const B = randomUUID();
      const ctx = { colonne: "personnes.courriel_chiffre", idLigne: randomUUID() };
      for (const t of [A, B]) {
        marquer("clé de chiffrement");
        await env.creerCleClient(t);
        marquer("clé de recherche");
        // Appel direct : l'état HTTP et le texte d'erreur d'OpenBao (sans secret) disent pourquoi la création échoue, ce que ErreurCoffre ne dit pas.
        const r = await fetch(`${bao.url}/v1/transit/keys/cli-${t}-recherche`, { method: "POST", headers: { "X-Vault-Token": bao.jeton, "Content-Type": "application/json" }, body: JSON.stringify({ type: "hmac", exportable: false }) });
        if (!r.ok) throw new Error(`création de la clé de recherche : HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      }
      marquer("chiffrement");
      const champ = await colonnes.chiffrerChamp(A, "essai@exemple.fr", ctx);
      const champB = await colonnes.chiffrerChamp(B, "essai@exemple.fr", ctx);
      await fichiers.deposerFichier(A, "exports/a.bin", Buffer.from("fichier fictif"));
      marquer("empreintes");
      const empA = await colonnes.empreinteRecherche(A, "essai@exemple.fr");
      expect(empA.equals(await colonnes.empreinteRecherche(B, "essai@exemple.fr"))).toBe(false);
      expect(await colonnes.dechiffrerChamp(A, champ, ctx)).toBe("essai@exemple.fr"); // cache chaud
      // Rotation de la clé de recherche : la version épinglée garde l'index stable.
      await appeler(bao, "POST", `transit/keys/cli-${A}-recherche/rotate`, {});
      expect((await colonnes.empreinteRecherche(A, "essai@exemple.fr")).equals(empA)).toBe(true);
      marquer("rotation");
      await colonnes.pivoterCle(A);
      expect(await colonnes.dechiffrerChamp(A, champ, ctx)).toBe("essai@exemple.fr");
      marquer("croisé");
      await expect(colonnes.dechiffrerChamp(B, champ, ctx)).rejects.toBeInstanceOf(ErreurCoffre);
      marquer("destruction");
      await env.detruireCleClient(A, `detruire-${A}`); // client fictif créé par ce test
      await expect(colonnes.dechiffrerChamp(A, champ, ctx)).rejects.toBeInstanceOf(ErreurCoffre);
      await expect(fichiers.lireFichier(A, "exports/a.bin")).rejects.toBeInstanceOf(ErreurCoffre);
      expect(await colonnes.dechiffrerChamp(B, champB, ctx)).toBe("essai@exemple.fr");
      trace(`COLONNES-INT terminé en ${Date.now() - debut} ms`);
    } catch (e) {
      // Seul le code ressort (ErreurCoffre : message = code) : aucun secret, pour lire l'échec dans le journal de la CI.
      trace(`COLONNES-INT échec à l'étape « ${etape} » : ${(e as Error).name} ${(e as Error).message.slice(0, 300)}`);
      throw e;
    }
  }, 120_000);
});
