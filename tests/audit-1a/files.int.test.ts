import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";
import { connect } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ouvrirConnexion, type Connexion } from "../../apps/api/src/files/connexion.ts";
import { creerFile, deposer, idTache } from "../../apps/api/src/files/files.ts";

// Porte du lot 1-A (T1A-19, partie A) : depuis le client A, essayer d'atteindre le client B dans les files Valkey et BullMQ.
// Le cloisonnement des files PAR CLIENT (utilisateurs Valkey, préfixes) vient au lot 2b : ici, ce que le socle promet déjà —
// aucune commande sans mot de passe, le tenantId de l'intention prime sur les données, et l'anti-doublon ne mêle jamais deux clients.
// Le test Valkey du socle redémarre le conteneur (SIGKILL) pendant que ces essais tournent : l'adresse est relue et la santé attendue.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = () => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=valkey");
const attendre = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const A = "2a2b3c4d-0000-4a00-8a00-00000000000a";
const B = "2a2b3c4d-0000-4b00-8b00-00000000000b";

// Le job ne montre pas le rapport JSON : chaque échec et le bilan du fichier vont sur la sortie d'erreur (jamais une valeur secrète).
const FICHIER = import.meta.url.split("/").pop() ?? "";
const bilan = { verts: 0, rouges: 0, attendus: 0 };
afterEach((ctx) => {
  const r = ctx.task.result;
  const rouge = r?.state === "fail";
  if (ctx.task.fails) {
    if (rouge) bilan.attendus++;
    else writeSync(2, `ECHEC ${ctx.task.name}\nattendu rouge (défaut corrigé ?) mais vert\n`);
  } else if (rouge) {
    bilan.rouges++;
    writeSync(2, `ECHEC ${ctx.task.name}\n${(r.errors ?? []).map((e) => e.message).join("\n")}\n`);
  } else if (r?.state === "pass") bilan.verts++;
});
afterAll(() => {
  writeSync(2, `BILAN ${FICHIER} : ${bilan.verts} verts, ${bilan.rouges} rouges, ${bilan.attendus} défauts attendus\n`);
});

async function parametres() {
  for (let i = 0; i < 60; i++) {
    try {
      const id = conteneur();
      if (id && docker("inspect", "-f", "{{.State.Health.Status}}", id) === "healthy") {
        const host = docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', id);
        const env = JSON.parse(docker("inspect", "-f", "{{json .Config.Env}}", id)) as string[];
        const password = env.find((e) => e.startsWith("VALKEY_MOT_DE_PASSE="))?.slice("VALKEY_MOT_DE_PASSE=".length) ?? "";
        if (host && password) return { host, port: 6379, password };
      }
    } catch {
      /* conteneur en cours de relance */
    }
    await attendre(1000);
  }
  throw new Error("Valkey indisponible");
}

// Échange brut sur le port de Valkey, sans bibliothèque : on envoie des commandes RESP en ligne et on lit les réponses telles quelles.
async function brut(commandes: string[]): Promise<string> {
  const { host, port } = await parametres();
  return new Promise<string>((ok, ko) => {
    const s = connect({ host, port });
    let recu = "";
    s.setTimeout(5000, () => (s.destroy(), ok(recu)));
    s.on("connect", () => s.write(`${commandes.join("\r\n")}\r\nQUIT\r\n`));
    s.on("data", (d: Buffer) => (recu += d.toString()));
    s.on("end", () => ok(recu));
    s.on("error", ko);
  });
}

const ouvertes: Connexion[] = [];
const fermer: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  for (const f of fermer) await f.close().catch(() => undefined);
  for (const c of ouvertes) await c.quit().catch(() => undefined);
});
async function connexion() {
  const c = await ouvrirConnexion(await parametres());
  ouvertes.push(c);
  return c;
}

describe("audit 1-A · files Valkey et BullMQ", () => {
  it("[A-051] @isolation sans mot de passe, ou avec un faux, Valkey refuse toute commande : ni lecture des files, ni écriture", async () => {
    // Une réponse par commande, dans l'ordre ; la dernière est celle de QUIT (« +OK », admise sans mot de passe).
    const reponses = (texte: string) => texte.split("\r\n").filter((l) => /^[-+*:$]/.test(l)).map((l) => l.split(" ")[0]);
    const sans = await brut(["PING", "KEYS axion:*", "SET audit-intrus 1", "CONFIG GET requirepass"]);
    expect(reponses(sans)).toEqual(["-NOAUTH", "-NOAUTH", "-NOAUTH", "-NOAUTH", "+OK"]);
    const faux = await brut([`AUTH ${randomBytes(16).toString("hex")}`, "PING", "KEYS axion:*"]);
    expect(reponses(faux)).toEqual(["-WRONGPASS", "-NOAUTH", "-NOAUTH", "+OK"]);
    const v = await connexion();
    expect(await v.client.exists("audit-intrus")).toBe(0);
  }, 60_000);

  it("[A-051] @isolation une tâche déposée pour A porte A, même si ses données disent B", async () => {
    const v = await connexion();
    const file = creerFile(`audit-1a-tenant-${Date.now()}`, v.client);
    fermer.push(file);
    await deposer(file, { tenantId: A, type: "essai", cle: "dossier-1" }, { tenantId: B, note: "se faire passer pour B" });
    const [tache] = await file.getJobs(["wait"]);
    expect(tache?.data.tenantId).toBe(A);
    expect(tache?.id).toBe(idTache({ tenantId: A, type: "essai", cle: "dossier-1" }));
  }, 60_000);

  it("[A-051] @isolation @anti-doublon la même intention pour A et pour B donne deux tâches : A ne peut ni écraser ni bloquer celle de B", async () => {
    const v = await connexion();
    const file = creerFile(`audit-1a-doublon-${Date.now()}`, v.client);
    fermer.push(file);
    const intention = { type: "relance", cle: "dossier-7" };
    await deposer(file, { ...intention, tenantId: B }, { contenu: "de B" });
    await deposer(file, { ...intention, tenantId: A }, { contenu: "de A" });
    await deposer(file, { ...intention, tenantId: A }, { contenu: "A rejoue" });
    const taches = await file.getJobs(["wait"]);
    expect(taches).toHaveLength(2);
    const deB = taches.find((t) => t.data.tenantId === B);
    expect(deB?.data.contenu).toBe("de B");
    expect(deB?.id).toBe(idTache({ ...intention, tenantId: B }));
    // Champs collés : « A » + type « x:y » ne peut pas reproduire l'identifiant de B (longueurs préfixées).
    expect(idTache({ tenantId: A, type: "relance", cle: "dossier-7" })).not.toBe(idTache({ tenantId: B, type: "relance", cle: "dossier-7" }));
  }, 60_000);

  it("[A-051] @isolation un tenantId absent, vide ou qui n'est pas un UUID est refusé avant tout dépôt", async () => {
    const v = await connexion();
    const nom = `audit-1a-invalide-${Date.now()}`;
    const file = creerFile(nom, v.client);
    fermer.push(file);
    for (const tenantId of ["", "pas-un-uuid", `${A}' OR '1'='1`, B.toUpperCase().replace(/-/g, "")]) {
      await expect(deposer(file, { tenantId, type: "essai", cle: "x" }, {}), tenantId).rejects.toThrow();
    }
    expect(await file.count()).toBe(0);
  }, 60_000);
});
