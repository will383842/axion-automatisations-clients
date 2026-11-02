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
// Une erreur hors de tout test (socket, minuterie) fait échouer le job sans nommer de test : on la nomme (nom et code, jamais le message),
// et le fichier échoue en fin de course (écouter l'événement retire à Vitest son propre constat : on le rend ici).
const nonGerees: string[] = [];
for (const evenement of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(evenement, (e: unknown) => {
    const err = e instanceof Error ? e : new Error(typeof e);
    nonGerees.push(`${evenement} ${err.name}`);
    writeSync(2, `ERREUR NON GEREE ${FICHIER} (${evenement}) : ${err.name} ${(err as { code?: string }).code ?? ""} ${(err.stack ?? "").split("\n").filter((l) => l.includes("audit-1a")).slice(0, 2).map((l) => l.trim()).join(" | ")}\n`);
  });
}
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
  if (nonGerees.length > 0) throw new Error(`erreurs hors test : ${nonGerees.join(", ")}`);
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
// Clé d'équipe de MOINDRE privilège (T1B-12) : limitée par allowed_routes à la lecture de /spend/logs. Créée avec la clé maîtresse (banc d'essai seulement) ;
// la clé maîtresse ne sert jamais à lire la dépense dans les essais de consommation. La valeur reste en mémoire : ni fichier, ni trace.
let cleEquipe = "";
const empreinteDe = (cle: string) => createHash("sha256").update(cle).digest("hex");
const lignesDeDepense = async (cle: string, empreinte: string) => {
  const r = await appeler(cle, "GET", `/spend/logs?api_key=${empreinte}&summarize=false`);
  let lignes: unknown = [];
  try { lignes = JSON.parse(r.texte); } catch { /* pas du JSON */ }
  return { statut: r.statut, lignes: (Array.isArray(lignes) ? lignes : []) as Record<string, unknown>[] };
};

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
  const equipe = JSON.parse((await appeler(MAITRE, "POST", "/key/generate", { key_alias: "equipe-lecture-depense", allowed_routes: ["/spend/logs"], metadata: { usage: "lecture de la dépense" } })).texte || "{}") as { key?: string };
  cleEquipe = equipe.key ?? "";
  if (!cleEquipe.startsWith("sk-")) throw new Error("clé d'équipe d'essai non créée");
  cleA = valeurs.get(refA) ?? "";
  cleB = valeurs.get(refB) ?? "";
  // Empreinte de la clé gardée par LiteLLM (SHA-256 hexadécimal de la clé) : c'est elle qui figure dans le journal de dépense.
  jetonB = createHash("sha256").update(cleB).digest("hex");
  const infoB = JSON.parse((await appeler(MAITRE, "GET", `/key/info?key=${jetonB}`)).texte || "{}") as { key?: string; info?: Record<string, unknown> };
  // Forme de la réponse (noms des champs seulement, jamais une valeur) : la lecture de consommation (consommation.ts) en dépend.
  writeSync(2, `FORME /key/info : ${JSON.stringify(Object.keys(infoB))} info ${JSON.stringify(Object.keys(infoB.info ?? {}).sort())} ; empreinte = key : ${infoB.key === jetonB}, = info.token : ${infoB.info?.["token"] === jetonB}\n`);
  for (const [cle, modele] of [[cleA, "claude-standard"], [cleA, "claude-standard"], [cleB, "mistral-souverain"]] as const) {
    const r = await discuter(cle, modele, `bonjour ${MARQUEUR}`);
    if (r.statut !== 200) throw new Error(`appel d'essai refusé (${r.statut})`);
  }
  // La dépense est écrite par lots : on attend qu'elle apparaisse pour les deux clés.
  for (let i = 0; ; i++) {
    const ecrites = async (cle: string) => (await lignesDeDepense(cleEquipe, empreinteDe(cle))).lignes.length;
    if ((await ecrites(cleA)) >= 2 && (await ecrites(cleB)) >= 1) break;
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
    // Refus de la route : 401 (rôle) ou 403 (allowed_routes de la clé), jamais 200 ni 404.
    expect([parA.statut, parAPourB.statut].every((x) => x === 401 || x === 403), "la clé d'un client est refusée sur /spend/logs").toBe(true);
    expect(maitre.statut).toBe(200);
    expect(maitre.lignes.length).toBeGreaterThan(0);
    expect(maitre.lignes.every((l) => l.api_key === jetonA)).toBe(true);
    const e = await creerConsommation({ url, coffre }).lire(A, refB).then(() => "ok", (x: unknown) => (x instanceof ErreurConsommation ? x.code : "autre"));
    expect(e).toBe("coffre_indisponible");
  }, 120_000);

  // Défaut corrigé (T1B-12, point 4) : la consommation se lit côté serveur avec la clé d'équipe de lecture (allowed_routes : /spend/logs),
  // filtrée par l'empreinte SHA-256 calculée localement ; chaque ligne rendue est revérifiée.
  it("[A-059] @isolation @lot-1b la consommation d'un client se lit contre la vraie passerelle (consommation.ts)", async () => {
    const consommation = creerConsommation({ url, coffre, lireCleEquipe: async () => cleEquipe });
    const lue = await consommation.lire(A, refA);
    expect(lue.jetonsEntree).toBeGreaterThan(0);
    expect(lue.jetonsSortie).toBeGreaterThan(0);
    expect(lue.coutMicroCentimes).toBeGreaterThan(0);
    // B n'a fait qu'un appel, A en a fait deux : la lecture de A ne mélange rien.
    const lueB = await consommation.lire(B, refB);
    expect(lue.coutMicroCentimes).toBeGreaterThan(lueB.coutMicroCentimes);
    // Forme réelle (noms des champs seulement) : les champs lus par consommation.ts existent dans la vraie réponse.
    const reelle = (await lignesDeDepense(cleEquipe, empreinteDe(cleA))).lignes[0] ?? {};
    writeSync(2, `FORME /spend/logs (ligne) : ${JSON.stringify(Object.keys(reelle).sort())}\n`);
    expect(Object.keys(reelle)).toEqual(expect.arrayContaining(["api_key", "spend", "prompt_tokens", "completion_tokens", "request_id", "startTime"]));
  }, 60_000);

  it("[A-059] @isolation une ligne d'un autre client dans la réponse réelle fait échouer la lecture (client_different)", async () => {
    const melange: typeof fetch = async (entree, init) => {
      const r = await fetch(entree, init);
      const lignes = JSON.parse(await r.text()) as Record<string, unknown>[];
      const autre = (await lignesDeDepense(cleEquipe, jetonB)).lignes[0] as Record<string, unknown>;
      return new Response(JSON.stringify([...lignes, autre]), { status: 200 });
    };
    const e = await creerConsommation({ url, coffre, lireCleEquipe: async () => cleEquipe, fetch: melange }).lire(A, refA).then(() => "ok", (x: unknown) => (x instanceof ErreurConsommation ? x.code : "autre"));
    expect(e).toBe("client_different");
  }, 60_000);

  it("[A-059] @isolation la clé d'équipe de lecture ne sert à rien d'autre qu'à lire la dépense : ni modèle, ni clé, ni information", async () => {
    const interdits: [string, string, unknown][] = [
      ["POST", "/v1/chat/completions", { model: "claude-standard", messages: [{ role: "user", content: "x" }] }],
      ["GET", `/key/info?key=${jetonB}`, undefined],
      ["POST", "/v2/key/info", { keys: [jetonB] }],
      ["GET", "/key/list", undefined],
      ["POST", "/key/generate", { key_alias: "intrus" }],
      ["POST", "/key/update", { key: jetonB, models: ["gpt-option"] }],
      ["POST", "/key/delete", { key_aliases: [`cli-${B}`] }],
      ["GET", "/model/info", undefined],
      ["GET", "/user/list", undefined],
      ["GET", "/config/yaml", undefined],
    ];
    const acceptees: string[] = [];
    for (const [m, chemin, corps] of interdits) {
      const r = await appeler(cleEquipe, m, chemin, corps);
      if (r.statut >= 200 && r.statut < 300) acceptees.push(`${m} ${chemin.split("?")[0]}`);
    }
    expect(acceptees).toEqual([]);
    expect((await lignesDeDepense(cleEquipe, empreinteDe(cleA))).statut).toBe(200);
  }, 120_000);

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

  // Défaut corrigé (T1B-12, point 5) : la clé d'un client lisait la fiche d'une AUTRE clé en donnant son empreinte (/key/info?key=<empreinte>,
  // /v2/key/info). Les clés des clients sont créées avec allowed_routes limité aux routes d'appel de modèle (cles.ts) : refus identique,
  // que l'empreinte existe ou non.
  it("[A-058] @isolation @lot-1b la clé de A ne lit pas la fiche de la clé de B en donnant son empreinte : même réponse qu'une empreinte inexistante", async () => {
    const inexistante = createHash("sha256").update(`sk-${randomBytes(16).toString("hex")}`).digest("hex");
    const pourB = await appeler(cleA, "GET", `/key/info?key=${jetonB}`);
    const pourRien = await appeler(cleA, "GET", `/key/info?key=${inexistante}`);
    const v2 = await appeler(cleA, "POST", "/v2/key/info", { keys: [jetonB] });
    writeSync(2, `FORME /key/info par la clé de A : empreinte de B ${pourB.statut} (${fuitesDans(pourB.texte, jetonB).join(", ") || "rien de B"}), empreinte inexistante ${pourRien.statut}, v2 ${v2.statut} (${fuitesDans(v2.texte, jetonB).join(", ") || "rien de B"})\n`);
    expect(fuitesDans(pourB.texte, jetonB)).toEqual([]);
    expect(fuitesDans(v2.texte, jetonB)).toEqual([]);
    expect(pourB.statut).toBe(pourRien.statut);
    // Un refus, pas un 404 : ni 200 (fiche rendue) ni 404 (« n'existe pas ») ; et la réponse est indiscernable.
    expect([401, 403]).toContain(pourB.statut);
    expect(pourB.texte).toBe(pourRien.texte);
    const v2Rien = await appeler(cleA, "POST", "/v2/key/info", { keys: [inexistante] });
    expect(v2.statut).toBe(v2Rien.statut);
    expect([401, 403]).toContain(v2.statut);
  }, 60_000);

  it("[A-058] @isolation la clé de A n'administre rien : ni créer, ni modifier, ni bloquer, ni régénérer, ni supprimer la clé de B", async () => {
    const ecritures: [string, string, unknown][] = [
      ["POST", "/key/generate", { key_alias: `cli-${A}-bis`, models: ["mistral-souverain"] }],
      ["POST", "/key/update", { key: cleB, models: ["gpt-option"], max_budget: 0 }],
      ["POST", "/key/update", { key: jetonB, models: ["gpt-option"], max_budget: 0 }],
      ["POST", "/key/block", { key: cleB }],
      ["POST", `/key/${jetonB}/regenerate`, {}],
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
    const infoB = JSON.parse((await appeler(MAITRE, "GET", `/key/info?key=${jetonB}`)).texte) as { info?: { key_alias?: string; models?: string[]; blocked?: boolean | null } };
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
