import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../scripts/garde-compose.ts";
import type { Coffre } from "../../apps/api/src/coffre/coffre.ts";
import { creerCles } from "../../apps/api/src/passerelle/cles.ts";
import { creerConsommation, ErreurConsommation } from "../../apps/api/src/passerelle/consommation.ts";

// Porte du lot 1-A (T1A-19, partie A) : passerelle d'IA en boîte noire. Le socle ne lance pas LiteLLM ; l'essai lance la VRAIE image
// épinglée dans ops/briques/litellm.json, avec ops/socle/litellm/config.yaml monté tel quel, une base PostgreSQL jetable (image du socle)
// et un faux fournisseur (Python de la même image) sous le nom faux-fournisseur.test attendu par la configuration.
// Écart assumé : la clé maîtresse et la clé du fournisseur sont passées dans l'environnement du conteneur d'essai (valeurs générées,
// préfixe TEST-NE-PAS-UTILISER-) au lieu d'OpenBao ; le point d'entrée demarrer.sh est éprouvé à part (tests/audit-1a/coffre.int.test.ts).
// Depuis la clé du client A : lire, modifier, révoquer ou compter la clé et la consommation du client B.
const racine = (chemin: string) => fileURLToPath(new URL(`../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
const brique = JSON.parse(readFileSync(racine("ops/briques/litellm.json"), "utf8")) as { image: string; version: string; empreinte: string };
const IMAGE = `${brique.image}:${brique.version}@${brique.empreinte}`;
const IMAGE_PG = (lireYaml(readFileSync(racine("ops/socle/compose.postgres.yml"), "utf8")) as unknown as { services: { postgres: { image: string } } }).services.postgres.image;
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const A = "4a2b3c4d-0000-4a00-8a00-00000000000a";
const B = "4a2b3c4d-0000-4b00-8b00-00000000000b";
const MAITRE = `sk-TEST-NE-PAS-UTILISER-${randomBytes(12).toString("hex")}`;
const FOURNISSEUR = `TEST-NE-PAS-UTILISER-${randomBytes(12).toString("hex")}`;
const MOT_DE_PASSE_PG = `TEST-NE-PAS-UTILISER-${randomBytes(12).toString("hex")}`;
const MARQUEUR = `MARQUEUR-ECHANGE-${randomBytes(8).toString("hex")}`;
const suffixe = randomBytes(4).toString("hex");
const RESEAU = `audit-passerelle-${suffixe}`;

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
// Une préparation qui échoue ne passe par aucun afterEach : on l'écrit aussi.
const garder = <T>(f: () => T | Promise<T>) => async () => {
  try {
    return await f();
  } catch (e) {
    writeSync(2, `ECHEC préparation ${FICHIER}\n${e instanceof Error ? e.message : "erreur"}\n`);
    throw e;
  }
};

// Faux fournisseur au format « chat completions » : usage déterministe, il répond « écho : <dernier message> » et n'écrit rien.
const FAUX = `
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def repondre(self, corps):
        b = json.dumps(corps).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_GET(self):
        self.repondre({"object": "list", "data": []})
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        q = json.loads(self.rfile.read(n) or b"{}")
        m = q.get("messages") or []
        texte = " ".join(str(x.get("content", "")) for x in m)
        dernier = str(m[-1].get("content", "")) if m else ""
        e = len(texte.split())
        self.repondre({"id": "faux", "object": "chat.completion", "created": 0, "model": q.get("model", "faux"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "écho : " + dernier}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": e, "completion_tokens": 3, "total_tokens": e + 3}})
ThreadingHTTPServer(("0.0.0.0", 4010), H).serve_forever()
`;

const lances: string[] = [];
let litellm = "";
let pgId = "";
let url = "";
afterAll(() => {
  for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ }
  try { docker("network", "rm", RESEAU); } catch { /* déjà retiré */ }
});

// Coffre en mémoire : il refuse la référence d'un autre client, comme le vrai (éprouvé dans coffre.int.test.ts).
const valeurs = new Map<string, string>();
const coffre: Pick<Coffre, "rangerIdentifiant" | "lireValeur"> = {
  async rangerIdentifiant(tenantId, _nom, valeur) {
    const reference = `bao:clients/${tenantId}/${randomUUID()}`;
    valeurs.set(reference, valeur);
    return reference;
  },
  async lireValeur(tenantId, reference) {
    if (!reference.startsWith(`bao:clients/${tenantId}/`)) throw new Error("reference_etrangere");
    return valeurs.get(reference) ?? "";
  },
};
const cles = () => creerCles({ url, lireCleMaitre: async () => MAITRE, coffre });

async function appeler(cle: string, methode: string, chemin: string, corps?: unknown) {
  try {
    const r = await fetch(`${url}${chemin}`, { method: methode, headers: { Authorization: `Bearer ${cle}`, ...(corps === undefined ? {} : { "Content-Type": "application/json" }) }, ...(corps === undefined ? {} : { body: JSON.stringify(corps) }), signal: AbortSignal.timeout(30_000) });
    return { statut: r.status, texte: await r.text() };
  } catch {
    return { statut: 0, texte: "" };
  }
}
const discuter = (cle: string, modele: string, contenu: string) => appeler(cle, "POST", "/v1/chat/completions", { model: modele, messages: [{ role: "user", content: contenu }] });

let refA = "";
let refB = "";
let cleA = "";
let cleB = "";
let jetonB = "";

beforeAll(garder(async () => {
  docker("network", "create", RESEAU);
  pgId = docker("run", "-d", "--rm", "--network", RESEAU, "--network-alias", "pg-passerelle", "-e", `POSTGRES_PASSWORD=${MOT_DE_PASSE_PG}`, "-e", "POSTGRES_DB=passerelle_ia", IMAGE_PG);
  lances.push(pgId);
  lances.push(docker("run", "-d", "--rm", "--network", RESEAU, "--network-alias", "faux-fournisseur.test", "--entrypoint", "python3", IMAGE, "-c", FAUX));
  for (let i = 0; ; i++) {
    try { if (docker("exec", pgId, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "passerelle_ia").includes("accepting")) break; } catch { /* démarrage */ }
    if (i > 90) throw new Error("base d'essai de la passerelle non démarrée");
    await pause(1000);
  }
  litellm = docker(
    "run", "-d", "--network", RESEAU,
    "-e", `LITELLM_MASTER_KEY=${MAITRE}`,
    "-e", `FOURNISSEUR_FAUX_CLE=${FOURNISSEUR}`,
    "-e", `DATABASE_URL=postgresql://postgres:${MOT_DE_PASSE_PG}@pg-passerelle:5432/passerelle_ia`,
    "-e", "LITELLM_LOCAL_MODEL_COST_MAP=True",
    "-v", `${racine("ops/socle/litellm/config.yaml")}:/etc/litellm/config.yaml:ro`,
    IMAGE, "--config", "/etc/litellm/config.yaml", "--port", "4000",
  );
  lances.push(litellm);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", litellm).split(" ")[0] ?? "";
  url = `http://${ip}:4000`;
  for (let i = 0; ; i++) {
    const r = await appeler(MAITRE, "GET", "/health/readiness");
    if (r.statut === 200 && /"db"\s*:\s*"connected"/.test(r.texte)) break;
    if (i > 240) {
      const etat = docker("inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", litellm);
      const journal = docker("logs", "--tail", "40", litellm).split("\n").filter((l) => !l.includes(MAITRE) && !l.includes(FOURNISSEUR) && !l.includes(MOT_DE_PASSE_PG)).join("\n");
      throw new Error(`LiteLLM d'essai non prêt (${etat}, dernier statut ${r.statut})\n${journal}`);
    }
    await pause(1500);
  }
  refA = (await cles().creerCleClient(A, { modelesPermis: ["claude-standard"] })).reference;
  refB = (await cles().creerCleClient(B, { modelesPermis: ["claude-standard", "mistral-souverain"] })).reference;
  cleA = valeurs.get(refA) ?? "";
  cleB = valeurs.get(refB) ?? "";
  // Empreinte de la clé gardée par LiteLLM (SHA-256 hexadécimal de la clé) : c'est elle qui figure dans le journal de dépense.
  jetonB = createHash("sha256").update(cleB).digest("hex");
  const infoB = JSON.parse((await appeler(MAITRE, "GET", `/key/info?key=${encodeURIComponent(cleB)}`)).texte || "{}") as { key?: string; info?: Record<string, unknown> };
  // Forme de la réponse (noms des champs seulement, jamais une valeur) : la lecture de consommation (consommation.ts) en dépend.
  writeSync(2, `FORME /key/info : ${JSON.stringify(Object.keys(infoB))} info ${JSON.stringify(Object.keys(infoB.info ?? {}).sort())} ; empreinte = key : ${infoB.key === jetonB}, = info.token : ${infoB.info?.["token"] === jetonB}\n`);
  for (const [cle, modele] of [[cleA, "claude-standard"], [cleA, "claude-standard"], [cleB, "mistral-souverain"]] as const) {
    const r = await discuter(cle, modele, `bonjour ${MARQUEUR}`);
    if (r.statut !== 200) throw new Error(`appel d'essai refusé (${r.statut})`);
  }
  // La dépense est écrite par lots : on attend qu'elle apparaisse pour les deux clés.
  for (let i = 0; ; i++) {
    const depense = async (cle: string) => Number(((JSON.parse((await appeler(cle, "GET", "/key/info")).texte || "{}") as { info?: { spend?: number } }).info ?? {}).spend ?? 0);
    if ((await depense(cleA)) > 0 && (await depense(cleB)) > 0) break;
    if (i > 120) throw new Error("dépense jamais écrite par la passerelle d'essai");
    await pause(1500);
  }
}), 600_000);

// Ce qui, vu par A, trahirait B (ou un secret de la passerelle). Une valeur que A a lui-même envoyée dans la demande n'est pas une fuite.
const traces = (): [string, string][] => [["alias de B", `cli-${B}`], ["identifiant de B", B], ["empreinte de B", jetonB], ["clé de B", cleB], ["clé maîtresse", MAITRE], ["clé du fournisseur", FOURNISSEUR]];
const fuitesDans = (texte: string, envoye = "") => traces().filter(([, v]) => v.length > 0 && texte.includes(v) && !envoye.includes(v)).map(([nom]) => nom);

describe("audit 1-A · passerelle d'IA (LiteLLM réel)", () => {
  it("[A-059] @isolation le journal de dépense est refusé à la clé d'un client ; le maître ne rend que les lignes de l'empreinte demandée ; une référence de B est refusée pour A", async () => {
    const jetonA = createHash("sha256").update(cleA).digest("hex");
    const lire = async (cle: string, jeton: string) => {
      const r = await appeler(cle, "GET", `/spend/logs?api_key=${jeton}&summarize=false`);
      let lignes: unknown = [];
      try { lignes = JSON.parse(r.texte); } catch { /* pas du JSON */ }
      return { statut: r.statut, lignes: (Array.isArray(lignes) ? lignes : []) as { api_key?: string }[] };
    };
    const parA = await lire(cleA, jetonA);
    const parAPourB = await lire(cleA, jetonB);
    const maitre = await lire(MAITRE, jetonA);
    // Forme de la réponse, sans aucune valeur : preuve rejouable lue dans le journal du job.
    writeSync(2, `FORME /spend/logs : clé de A ${parA.statut}, clé de A pour B ${parAPourB.statut}, maître ${maitre.statut} (${maitre.lignes.length} lignes, champs ${JSON.stringify(Object.keys(maitre.lignes[0] ?? {}).sort())})\n`);
    expect({ parA: parA.statut, parAPourB: parAPourB.statut }).toEqual({ parA: 401, parAPourB: 401 });
    expect(maitre.statut).toBe(200);
    expect(maitre.lignes.length).toBeGreaterThan(0);
    expect(maitre.lignes.every((l) => l.api_key === jetonA)).toBe(true);
    const e = await creerConsommation({ url, coffre }).lire(A, refB).then(() => "ok", (x: unknown) => (x instanceof ErreurConsommation ? x.code : "autre"));
    expect(e).toBe("coffre_indisponible");
  }, 120_000);

  // Défaut constaté (T1A-19, PR 90, 3e et 4e exécutions) : contre la passerelle épinglée (ops/briques/litellm.json), creerConsommation().lire
  // échoue TOUJOURS en « reponse_invalide » : /key/info ne rend pas info.token (le schéma de consommation.ts l'exige), et /spend/logs refuse
  // la clé d'un client (401, essai ci-dessus). La consommation d'un client (A-059) n'est donc pas lisible. Correction (lot 1-B) : lire la
  // dépense côté serveur avec un jeton d'administration de la passerelle, filtrée par l'empreinte SHA-256 de la clé du client calculée
  // localement, chaque ligne revérifiée ; les tests unitaires de consommation.ts doivent reprendre la forme réelle des réponses.
  it.fails("[A-059] @isolation @lot-1b la consommation d'un client se lit contre la vraie passerelle (consommation.ts)", async () => {
    const lue = await creerConsommation({ url, coffre }).lire(A, refA);
    expect(lue.jetonsEntree).toBeGreaterThan(0);
  }, 60_000);

  it("[A-058] @isolation la clé de A ne lit ni la dépense, ni le journal, ni la liste des clés de B, par aucune route d'administration", async () => {
    const lectures = [
      `/spend/logs?api_key=${encodeURIComponent(jetonB)}`,
      `/spend/logs?api_key=${encodeURIComponent(jetonB)}&summarize=false`,
      "/spend/logs",
      "/spend/logs?summarize=false",
      "/spend/keys",
      "/key/list",
      "/key/list?return_full_object=true",
      `/key/list?key_alias=cli-${B}`,
      "/global/spend/keys",
      "/global/spend/logs",
      "/global/spend/report",
      "/user/info",
      "/user/list",
      "/team/list",
      "/customer/list",
      "/model/info",
      "/v1/model/info",
      "/get/config/callbacks",
      "/config/yaml",
      "/health",
      "/settings",
    ];
    // Les chemins sont écrits avec des noms à la place des valeurs, pour que le message d'échec n'en porte aucune.
    const nommer = (chemin: string) => chemin.replace(jetonB, "<empreinte de B>").replace(B, "<B>");
    const fuites: string[] = [];
    for (const chemin of lectures) {
      const r = await appeler(cleA, "GET", chemin);
      const f = fuitesDans(r.texte, decodeURIComponent(chemin));
      if (f.length > 0) fuites.push(`${nommer(chemin)} (${r.statut}) : ${f.join(", ")}`);
    }
    writeSync(2, `FUITES passerelle (administration) : ${fuites.length ? fuites.join(" | ") : "aucune"}\n`);
    expect(fuites).toEqual([]);
  }, 180_000);

  // Défaut constaté (T1A-19, PR 90, 4e exécution) : la clé d'un client lit la fiche d'une AUTRE clé dès qu'elle en donne l'empreinte
  // (/key/info?key=<empreinte>, /v2/key/info) : 200 avec l'alias cli-<B> et le tenant_id de B, au lieu de la réponse d'une clé inexistante.
  // Correction (lot 1-B) : clés de client créées avec allowed_routes limité aux routes d'appel de modèle (cles.ts), ou filtre de routes
  // devant la passerelle ; la lecture de la fiche passe par le serveur (voir le défaut de consommation ci-dessus).
  it.fails("[A-058] @isolation @lot-1b la clé de A ne lit pas la fiche de la clé de B en donnant son empreinte : même réponse qu'une empreinte inexistante", async () => {
    const inexistante = createHash("sha256").update(`sk-${randomBytes(16).toString("hex")}`).digest("hex");
    const pourB = await appeler(cleA, "GET", `/key/info?key=${jetonB}`);
    const pourRien = await appeler(cleA, "GET", `/key/info?key=${inexistante}`);
    const v2 = await appeler(cleA, "POST", "/v2/key/info", { keys: [jetonB] });
    writeSync(2, `FORME /key/info par la clé de A : empreinte de B ${pourB.statut} (${fuitesDans(pourB.texte, jetonB).join(", ") || "rien de B"}), empreinte inexistante ${pourRien.statut}, v2 ${v2.statut} (${fuitesDans(v2.texte, jetonB).join(", ") || "rien de B"})\n`);
    expect(fuitesDans(pourB.texte, jetonB)).toEqual([]);
    expect(fuitesDans(v2.texte, jetonB)).toEqual([]);
    expect(pourB.statut).toBe(pourRien.statut);
  }, 60_000);

  it("[A-058] @isolation la clé de A n'administre rien : ni créer, ni modifier, ni bloquer, ni régénérer, ni supprimer la clé de B", async () => {
    const ecritures: [string, string, unknown][] = [
      ["POST", "/key/generate", { key_alias: `cli-${A}-bis`, models: ["mistral-souverain"] }],
      ["POST", "/key/update", { key: cleB, models: ["gpt-option"], max_budget: 0 }],
      ["POST", "/key/update", { key: jetonB, models: ["gpt-option"], max_budget: 0 }],
      ["POST", "/key/block", { key: cleB }],
      ["POST", `/key/${encodeURIComponent(cleB)}/regenerate`, {}],
      ["POST", "/key/regenerate", { key: cleB }],
      ["POST", "/key/delete", { key_aliases: [`cli-${B}`] }],
      ["POST", "/key/delete", { keys: [cleB] }],
      ["POST", "/key/update", { key: cleA, models: ["claude-standard", "mistral-souverain", "gpt-option"] }],
    ];
    const acceptees: string[] = [];
    for (const [m, chemin, corps] of ecritures) {
      const r = await appeler(cleA, m, chemin, corps);
      if (r.statut >= 200 && r.statut < 300) acceptees.push(`${chemin} ${JSON.stringify(Object.keys(corps as object))}`);
    }
    expect(acceptees).toEqual([]);
    // B intacte : même alias, mêmes modèles, toujours utilisable ; A n'a pas élargi ses modèles.
    const infoB = JSON.parse((await appeler(MAITRE, "GET", `/key/info?key=${encodeURIComponent(cleB)}`)).texte) as { info?: { key_alias?: string; models?: string[]; blocked?: boolean | null } };
    expect(infoB.info?.key_alias).toBe(`cli-${B}`);
    expect([...(infoB.info?.models ?? [])].sort()).toEqual(["claude-standard", "mistral-souverain"]);
    expect(infoB.info?.blocked ?? false).toBe(false);
    expect((await discuter(cleB, "mistral-souverain", "toujours là ?")).statut).toBe(200);
    expect((await discuter(cleA, "mistral-souverain", "hors liste")).statut).not.toBe(200);
  }, 180_000);

  it("[C-024] le texte des échanges n'est gardé ni dans la base de la passerelle, ni dans son journal", async () => {
    const vidage = docker("exec", pgId, "pg_dump", "-U", "postgres", "-d", "passerelle_ia", "--data-only");
    expect(vidage.length, "témoin : la base de la passerelle contient des lignes").toBeGreaterThan(1000);
    expect(vidage.includes(`cli-${A}`), "témoin : la clé de A est dans la base").toBe(true);
    expect(vidage.includes(MARQUEUR), "texte d'un échange dans la base").toBe(false);
    const journal = execFileSync("docker", ["logs", litellm], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    expect(journal.includes(MARQUEUR), "texte d'un échange dans le journal").toBe(false);
    const presentes = { maitre: journal.includes(MAITRE), fournisseur: journal.includes(FOURNISSEUR), cleA: journal.includes(cleA), cleB: journal.includes(cleB), motDePasseBase: journal.includes(MOT_DE_PASSE_PG) };
    writeSync(2, `CLES dans le journal de la passerelle : ${JSON.stringify(presentes)}\n`);
    expect(presentes, "clé dans le journal").toEqual({ maitre: false, fournisseur: false, cleA: false, cleB: false, motDePasseBase: false });
  }, 120_000);

  // En dernier : la clé de B est révoquée pour de bon.
  it("[A-058] @isolation révoquer B ne touche pas A, et la clé révoquée ne sert plus", async () => {
    await cles().revoquerCle(B);
    let refusee = false;
    for (let i = 0; i < 20 && !refusee; i++) {
      refusee = (await discuter(cleB, "claude-standard", "après révocation")).statut === 401;
      if (!refusee) await pause(1000);
    }
    expect(refusee).toBe(true);
    expect((await discuter(cleA, "claude-standard", "toujours là ?")).statut).toBe(200);
  }, 120_000);
});
