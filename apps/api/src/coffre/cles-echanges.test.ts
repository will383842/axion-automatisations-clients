import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { ErreurCoffre } from "./coffre.js";
import { creerClesEchanges } from "./cles-echanges.js";

const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url)), "utf8");
type Droits = { chemin: string; capacites: string[] }[];

// Les politiques ne contiennent que des blocs `path "…" { capabilities = ["…"] }` : tout le reste est refusé.
function lireDroits(texte: string): Droits {
  const jetons: string[] = [];
  for (let i = 0; i < texte.length; ) {
    const c = texte[i] ?? "";
    if (c === " " || c === "\n" || c === "\t" || c === "\r") i++;
    else if (c === "#") while (i < texte.length && texte[i] !== "\n") i++;
    else if (c === '"') { const fin = texte.indexOf('"', i + 1); if (fin < 0) throw new Error("chaîne non fermée"); jetons.push(texte.slice(i, fin + 1)); i = fin + 1; }
    else if ("{}[]=,".includes(c)) { jetons.push(c); i++; }
    else { let j = i; while (j < texte.length && !" \n\t\r{}[]=,\"#".includes(texte[j] ?? "")) j++; jetons.push(texte.slice(i, j)); i = j; }
  }
  const sortie: Droits = [];
  const chaine = (j: string | undefined) => (j?.startsWith('"') ? j.slice(1, -1) : (() => { throw new Error(`chaîne attendue : ${j}`); })());
  let p = 0;
  while (p < jetons.length) {
    if (jetons[p++] !== "path") throw new Error("seul `path` est permis");
    const chemin = chaine(jetons[p++]);
    if (jetons[p++] !== "{" || jetons[p++] !== "capabilities" || jetons[p++] !== "=" || jetons[p++] !== "[") throw new Error("forme de bloc inattendue");
    const capacites: string[] = [];
    while (jetons[p] !== "]") { capacites.push(chaine(jetons[p++])); if (jetons[p] === ",") p++; }
    p++;
    if (jetons[p++] !== "}") throw new Error("« } » attendu");
    sortie.push({ chemin, capacites });
  }
  return sortie;
}
const politique = (role: string) => lireDroits(lire(`ops/socle/openbao/politiques/${role}.hcl`));
function correspond(modele: string, chemin: string): boolean {
  const m = modele.split("/"), c = chemin.split("/");
  for (let i = 0; i < m.length; i++) {
    const seg = m[i] ?? "";
    if (seg.endsWith("*") && i === m.length - 1) return (c[i] ?? "").startsWith(seg.slice(0, -1)) && c.length >= i + 1;
    if (seg !== "+" && seg !== c[i]) return false;
  }
  return m.length === c.length;
}
const CAPACITE: Record<string, string> = { GET: "read", LIST: "list" };

// Imitation du KV v2 monté sur technique/, avec les droits lus dans les VRAIS fichiers de politiques.
function creerFauxKv() {
  const etat = { scelle: false, appels: [] as { methode: string; url: string; corps: string }[], jetons: new Map<string, string>(), kv: new Map<string, { version: number; data: Record<string, unknown> }>(), forcer: undefined as undefined | Record<string, unknown> };
  const jeton = (role: string) => { const j = `jeton-${randomUUID()}`; etat.jetons.set(j, role); return j; };
  const rep = (statut: number, corps: unknown) => new Response(statut === 204 ? null : JSON.stringify(corps), { status: statut });
  const f: typeof fetch = async (entree, init) => {
    const url = new URL(String(entree));
    const methode = (init?.method ?? "GET").toUpperCase();
    const corps = typeof init?.body === "string" ? init.body : "";
    etat.appels.push({ methode, url: String(entree), corps });
    if (etat.scelle) return rep(503, { errors: ["Vault is sealed"] });
    const chemin = url.pathname.replace(/^\/v1\//, "");
    const role = etat.jetons.get(new Headers(init?.headers).get("x-vault-token") ?? "") ?? "";
    const capacites = methode === "POST" ? ["create", "update"] : [CAPACITE[methode] ?? "?"];
    if (!role || !politique(role).some((d) => correspond(d.chemin, chemin) && capacites.some((c) => d.capacites.includes(c)))) return rep(403, { errors: ["permission denied"] });
    let m: RegExpExecArray | null;
    if ((m = /^technique\/data\/(.+)$/.exec(chemin))) {
      const p = m[1] ?? "";
      if (methode === "GET") { const v = etat.kv.get(p); return v ? rep(200, { data: { data: etat.forcer ?? v.data, metadata: { version: v.version } } }) : rep(404, { errors: [] }); }
      const j = JSON.parse(corps) as { data: Record<string, unknown>; options?: { cas?: number } };
      const actuel = etat.kv.get(p);
      if (j.options?.cas !== undefined && j.options.cas !== (actuel?.version ?? 0)) return rep(400, { errors: ["check-and-set parameter did not match the current version"] });
      etat.kv.set(p, { version: (actuel?.version ?? 0) + 1, data: j.data });
      return rep(200, { data: { version: (actuel?.version ?? 0) + 1 } });
    }
    if ((m = /^technique\/metadata\/(.+)$/.exec(chemin)) && methode === "LIST") {
      const prefixe = `${m[1]}/`;
      const cles = [...etat.kv.keys()].filter((k) => k.startsWith(prefixe)).map((k) => k.slice(prefixe.length));
      return cles.length ? rep(200, { data: { keys: cles } }) : rep(404, { errors: [] });
    }
    return rep(404, { errors: [] });
  };
  return { etat, jeton, fetch: f };
}

const URL_BAO = "http://openbao.test:8200";
const HEURE = 3600_000;
let bao: ReturnType<typeof creerFauxKv>;
let horloge: number;
const echanges = (role = "echanges") => creerClesEchanges({ url: URL_BAO, jeton: bao.jeton(role), fetch: bao.fetch, maintenant: () => horloge });
beforeEach(() => { bao = creerFauxKv(); horloge = Date.UTC(2026, 9, 25, 8, 0, 0); });
const refus = async (p: Promise<unknown>, code?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ErreurCoffre);
  if (code) expect((e as ErreurCoffre).code).toBe(code);
  return e as ErreurCoffre;
};

describe("clés HMAC des échanges (C-015)", () => {
  it("[C-015] @isolation la clé HMAC c1 est lue par la politique echanges et refusée aux politiques courtier, equipe et api", async () => {
    const cle = await echanges().tourner("c1", "emission");
    expect(cle.secret.length).toBe(32);
    expect((await echanges().cleActive("c1", "emission")).kid).toBe(cle.kid);
    for (const role of ["courtier", "equipe", "api", "signature", "inconnu"]) {
      await refus(echanges(role).cleActive("c1", "emission"), "refuse");
      await refus(echanges(role).clesAcceptees("c1", "emission"), "refuse");
      await refus(echanges(role).tourner("c1", "emission"), "refuse");
    }
  });
  it("[C-015] deux clés actives : l'ancienne est acceptée pendant le chevauchement de 24 h puis refusée (horloge simulée)", async () => {
    const ancienne = await echanges().tourner("c1", "emission");
    horloge += HEURE;
    const nouvelle = await echanges().tourner("c1", "emission");
    expect((await echanges().cleActive("c1", "emission")).kid).toBe(nouvelle.kid);
    expect((await echanges().clesAcceptees("c1", "emission")).map((c) => c.kid).sort()).toEqual([ancienne.kid, nouvelle.kid].sort());
    horloge += 24 * HEURE - 1;
    expect((await echanges().clesAcceptees("c1", "emission")).map((c) => c.kid)).toContain(ancienne.kid);
    horloge += 1;
    expect((await echanges().clesAcceptees("c1", "emission")).map((c) => c.kid)).toEqual([nouvelle.kid]);
  });
  it("[C-015] chaque sens et chaque canal ont leurs propres clés ; c4-<cellule> est accepté", async () => {
    const e = await echanges().tourner("c4-lemoine", "reception");
    expect((await echanges().cleActive("c4-lemoine", "reception")).kid).toBe(e.kid);
    await refus(echanges().cleActive("c4-lemoine", "emission"), "introuvable");
    await refus(echanges().cleActive("c1", "reception"), "introuvable");
  });
  it.each(["", "C1", "c5", "c1/../clients/x", "c1/", "c4-", "c4-A", "c4-a/b", "*", "..", "c1\n", "c1?x=1", "c1%2f", "c4--a"])(
    "[C-015] @isolation canal piégé %j refusé sans appel réseau",
    async (canal) => {
      await refus(echanges().cleActive(canal, "emission"));
      await refus(echanges().tourner(canal, "emission"));
      expect(bao.etat.appels).toEqual([]);
    },
  );
  it("[C-015] un sens inconnu est refusé sans appel réseau", async () => {
    await refus(echanges().cleActive("c1", "x/../y" as "emission"));
    expect(bao.etat.appels).toEqual([]);
  });
  it("[C-015] l'écriture d'une clé ne remplace jamais une clé existante (création seule)", async () => {
    await echanges().tourner("c2", "emission");
    const [chemin] = [...bao.etat.kv.keys()];
    const avant = JSON.stringify(bao.etat.kv.get(chemin ?? ""));
    const ecriture = bao.etat.appels.find((a) => a.methode === "POST");
    expect(JSON.parse(ecriture?.corps ?? "{}").options).toEqual({ cas: 0 });
    expect(JSON.stringify(bao.etat.kv.get(chemin ?? ""))).toBe(avant);
  });
  it("[C-015] une seconde rotation pendant le chevauchement est refusée : jamais trois clés acceptées", async () => {
    await echanges().tourner("c3", "emission");
    horloge += HEURE;
    await echanges().tourner("c3", "emission");
    horloge += HEURE;
    await refus(echanges().tourner("c3", "emission"), "requete_refusee");
    expect((await echanges().clesAcceptees("c3", "emission")).length).toBe(2);
    horloge += 24 * HEURE;
    await echanges().tourner("c3", "emission");
  });
  it.each([
    ["trop courte", () => randomBytes(16).toString("base64")],
    ["pas en base64", () => "%%%"],
    ["base64 non canonique", () => `${randomBytes(32).toString("base64")}\n`],
    ["pas une chaîne", () => 12],
  ])("[C-015] une clé %s renvoyée par le coffre est refusée : jamais de HMAC avec une clé faible", async (_n, fabrique) => {
    await echanges().tourner("c1", "emission");
    bao.etat.forcer = { secret: fabrique(), sens: "emission", cree_le: horloge, retiree_le: null };
    await refus(echanges().cleActive("c1", "emission"), "coffre_indisponible");
  });
  it("[C-015] OpenBao scellé → coffre_scelle, sans clé de repli ; le secret n'est jamais dans une adresse ni une erreur", async () => {
    const cle = await echanges().tourner("c1", "emission");
    const secret = cle.secret.toString("base64");
    bao.etat.scelle = true;
    const e = await refus(echanges().cleActive("c1", "emission"), "coffre_scelle");
    expect(`${e.message}${e.stack ?? ""}`).not.toContain(secret);
    bao.etat.scelle = false;
    expect(bao.etat.appels.filter((a) => a.url.includes(secret))).toEqual([]);
    expect(bao.etat.appels.filter((a) => a.corps.includes(secret)).length).toBe(1);
  });
});

describe("politiques OpenBao de la fiche T1A-07", () => {
  const interdits = (d: Droits) => d.filter((x) => x.capacites.some((c) => ["sudo", "delete"].includes(c)) || x.chemin === "*" || x.chemin.startsWith("sys/") || x.chemin.includes("export"));
  it("[C-015] @isolation echanges : lecture, écriture et liste de technique/…/echanges seulement ; rien d'autre", () => {
    expect(politique("echanges")).toEqual([
      { chemin: "technique/data/echanges/*", capacites: ["create", "update", "read"] },
      { chemin: "technique/metadata/echanges/*", capacites: ["list"] },
    ]);
  });
  it("[A-193] signature : signer, vérifier et lire l'état de la clé modules-signature ; ni copie ni export ni création", () => {
    expect(politique("signature")).toEqual([
      { chemin: "transit/sign/modules-signature", capacites: ["update"] },
      { chemin: "transit/verify/modules-signature", capacites: ["update"] },
      { chemin: "transit/keys/modules-signature", capacites: ["read"] },
    ]);
  });
  it("[A-303] secours : copie de la clé de signature et lecture des clés HMAC, sans signer ni écrire", () => {
    expect(politique("secours")).toEqual([
      { chemin: "transit/backup/modules-signature", capacites: ["read"] },
      { chemin: "transit/keys/modules-signature", capacites: ["read"] },
      { chemin: "technique/data/echanges/*", capacites: ["read"] },
      { chemin: "technique/metadata/echanges/*", capacites: ["list"] },
    ]);
  });
  it("[C-015] @isolation aucune politique ne donne sudo, suppression, export ni chemin large ; courtier, equipe et api ne touchent pas technique/", () => {
    for (const role of ["signature", "echanges", "secours", "courtier", "equipe", "api"]) expect(interdits(politique(role)), role).toEqual([]);
    for (const role of ["courtier", "equipe", "api"]) expect(politique(role).filter((d) => d.chemin.startsWith("technique") || d.chemin.includes("modules-signature")), role).toEqual([]);
  });
  it("[A-193] initialiser.sh : monte technique/ (KV v2), crée la clé ed25519 non exportable avec copie permise, écrit les trois politiques et leurs jetons", () => {
    const s = lire("ops/socle/openbao/initialiser.sh");
    expect(s).toContain("secrets enable -path=technique -version=2 kv");
    expect(s).toContain("transit/keys/modules-signature type=ed25519 exportable=false allow_plaintext_backup=true");
    expect(s).toContain("for role in api courtier equipe signature echanges secours; do");
    expect(s).not.toContain("transit/export");
    expect(s).not.toMatch(/echo[^\n]*(jeton|part)/);
  });
});
