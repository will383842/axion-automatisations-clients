import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { verifierCompose, lireYaml } from "../../../../scripts/garde-compose.js";
import { creerCoffre, ErreurCoffre } from "./coffre.js";
import { creerEnveloppe } from "./enveloppe.js";

// Imitation d'OpenBao : les droits de chaque rôle sont lus dans les VRAIS fichiers de politiques,
// pour que le test et le serveur ne puissent pas diverger.
const lireFichier = (chemin: string) => readFileSync(fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url)), "utf8");
export type Droits = { chemin: string; capacites: string[] }[];

// Analyseur HCL strict (blocs, étiquettes, chaînes, nombres, booléens, listes de chaînes) : tout le reste est refusé.
export type Valeur = string | number | boolean | string[];
export interface Bloc { type: string; etiquettes: string[]; attrs: Record<string, Valeur>; blocs: Bloc[] }
export function lireHcl(texte: string): Bloc {
  const jetons: string[] = [];
  for (let i = 0; i < texte.length; ) {
    const c = texte[i] ?? "";
    if (/\s/.test(c)) i++;
    else if (c === "#") while (i < texte.length && texte[i] !== "\n") i++;
    else if (c === '"') {
      const fin = texte.indexOf('"', i + 1);
      if (fin < 0) throw new Error("HCL : chaîne non fermée");
      jetons.push(texte.slice(i, fin + 1));
      i = fin + 1;
    } else if ("{}[]=,".includes(c)) { jetons.push(c); i++; }
    else { const m = /^[\w][\w.-]*/.exec(texte.slice(i)); if (!m) throw new Error(`HCL : caractère inattendu ${c}`); jetons.push(m[0]); i += m[0].length; }
  }
  let pos = 0;
  const chaine = (j: string | undefined) => (j?.startsWith('"') ? j.slice(1, -1) : undefined);
  const valeur = (): Valeur => {
    const j = jetons[pos++];
    if (j === "[") {
      const liste: string[] = [];
      while (jetons[pos] !== "]") {
        const s = chaine(jetons[pos++]);
        if (s === undefined) throw new Error("HCL : liste de chaînes attendue");
        liste.push(s);
        if (jetons[pos] === ",") pos++;
      }
      pos++;
      return liste;
    }
    if (j === "true" || j === "false") return j === "true";
    if (j !== undefined && /^\d+$/.test(j)) return Number(j);
    const s = chaine(j);
    if (s === undefined) throw new Error(`HCL : valeur illisible ${j}`);
    return s;
  };
  const corps = (type: string, etiquettes: string[], ferme: boolean): Bloc => {
    const bloc: Bloc = { type, etiquettes, attrs: {}, blocs: [] };
    while (pos < jetons.length && jetons[pos] !== "}") {
      const nom = jetons[pos++] ?? "";
      if (jetons[pos] === "=") { pos++; bloc.attrs[nom] = valeur(); continue; }
      const et: string[] = [];
      while (jetons[pos]?.startsWith('"')) et.push(chaine(jetons[pos++]) ?? "");
      if (jetons[pos++] !== "{") throw new Error(`HCL : « { » attendu après ${nom}`);
      bloc.blocs.push(corps(nom, et, true));
    }
    if (ferme && jetons[pos++] !== "}") throw new Error("HCL : « } » manquant");
    return bloc;
  };
  return corps("", [], false);
}
export function lireDroits(texte: string): Droits {
  return lireHcl(texte).blocs.map((b) => {
    const c = b.attrs.capabilities;
    if (b.type !== "path" || b.etiquettes.length !== 1 || !Array.isArray(c) || Object.keys(b.attrs).length !== 1 || b.blocs.length) throw new Error("politique : seul `path` avec `capabilities` est permis");
    return { chemin: b.etiquettes[0] as string, capacites: c };
  });
}
export const politique = (role: string) => lireDroits(lireFichier(`ops/socle/openbao/politiques/${role}.hcl`));

// `+` = un segment ; `*` en fin = tout le reste (règles d'OpenBao).
export function chemin_correspond(modele: string, chemin: string): boolean {
  const m = modele.split("/"), c = chemin.split("/");
  for (let i = 0; i < m.length; i++) {
    const seg = m[i] ?? "";
    if (seg.endsWith("*") && i === m.length - 1) return (c[i] ?? "").startsWith(seg.slice(0, -1)) && c.length >= i + 1;
    if (seg !== "+" && seg !== c[i]) return false;
  }
  return m.length === c.length;
}
const CAPACITE: Record<string, string[]> = { GET: ["read"], POST: ["create", "update"], PUT: ["create", "update"], DELETE: ["delete"] };

export function creerFauxBao() {
  const etat = {
    scelle: false,
    panne: false,
    appels: [] as { methode: string; url: string; corps: string }[],
    jetons: new Map<string, string>(),
    kv: new Map<string, { valeur: string; nom: string }>(),
    meta: new Map<string, { nom: string; expire_le: string | null }>(),
    cles: new Map<string, { secret: Buffer; supprimable: boolean }>(),
    reponseDatakey: undefined as undefined | ((plain: string, cipher: string) => Record<string, unknown>),
  };
  const jeton = (role: string) => { const j = `jeton-${randomUUID()}`; etat.jetons.set(j, role); return j; };
  const rep = (statut: number, corps: unknown) => new Response(JSON.stringify(corps), { status: statut, headers: { "content-type": "application/json" } });
  const fetchImitation: typeof fetch = async (entree, init) => {
    const url = new URL(String(entree));
    const methode = (init?.method ?? "GET").toUpperCase();
    const corps = typeof init?.body === "string" ? init.body : "";
    etat.appels.push({ methode, url: String(entree), corps });
    if (etat.panne) throw new TypeError("fetch failed");
    if (etat.scelle) return rep(503, { errors: ["Vault is sealed"] });
    const entetes = new Headers(init?.headers);
    const role = etat.jetons.get(entetes.get("x-vault-token") ?? "");
    const chemin = url.pathname.replace(/^\/v1\//, "");
    const droits = role ? politique(role) : [];
    const permis = droits.some((d) => chemin_correspond(d.chemin, chemin) && (CAPACITE[methode] ?? []).some((c) => d.capacites.includes(c)));
    if (!permis) return rep(403, { errors: ["permission denied"] });
    const json = corps ? (JSON.parse(corps) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null;
    if ((m = /^clients\/data\/(.+)$/.exec(chemin))) {
      const p = m[1] ?? "";
      if (methode === "GET") { const v = etat.kv.get(p); return v ? rep(200, { data: { data: v } }) : rep(404, { errors: [] }); }
      const d = json.data as { valeur: string; nom: string };
      etat.kv.set(p, { valeur: d.valeur, nom: d.nom });
      return rep(200, { data: { version: 1 } });
    }
    if ((m = /^clients\/metadata\/(.+)$/.exec(chemin))) {
      const p = m[1] ?? "";
      if (methode === "GET") { const v = etat.meta.get(p); return v ? rep(200, { data: { custom_metadata: v, current_version: 1 } }) : rep(404, { errors: [] }); }
      etat.meta.set(p, json.custom_metadata as { nom: string; expire_le: string | null });
      return rep(204, null);
    }
    if ((m = /^transit\/keys\/(cli-[^/]+)(\/config)?$/.exec(chemin))) {
      const nom = m[1] ?? "";
      if (methode === "DELETE") {
        if (!etat.cles.get(nom)?.supprimable) return rep(400, { errors: ["deletion is not allowed"] });
        etat.cles.delete(nom);
        return rep(204, null);
      }
      if (m[2]) { const k = etat.cles.get(nom); if (k) k.supprimable = json.deletion_allowed === true; return rep(204, null); }
      if (json.exportable !== false || json.type !== "aes256-gcm96") return rep(400, { errors: ["clé non conforme"] });
      etat.cles.set(nom, { secret: randomBytes(32), supprimable: false });
      return rep(204, null);
    }
    if ((m = /^transit\/datakey\/plaintext\/(cli-.+)$/.exec(chemin))) {
      const k = etat.cles.get(m[1] ?? "");
      if (!k) return rep(400, { errors: ["encryption key not found"] });
      const plain = randomBytes(32), iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", k.secret, iv);
      const sortie = Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
      const p = plain.toString("base64"), ch = `vault:v1:${sortie.toString("base64")}`;
      return rep(200, { data: etat.reponseDatakey ? etat.reponseDatakey(p, ch) : { plaintext: p, ciphertext: ch } });
    }
    if ((m = /^transit\/decrypt\/(cli-.+)$/.exec(chemin))) {
      const k = etat.cles.get(m[1] ?? "");
      if (!k) return rep(400, { errors: ["encryption key not found"] });
      try {
        const brut = Buffer.from(String(json.ciphertext).replace(/^vault:v\d+:/, ""), "base64");
        const d = createDecipheriv("aes-256-gcm", k.secret, brut.subarray(0, 12));
        d.setAuthTag(brut.subarray(brut.length - 16));
        const plain = Buffer.concat([d.update(brut.subarray(12, brut.length - 16)), d.final()]);
        return rep(200, { data: { plaintext: plain.toString("base64") } });
      } catch {
        return rep(400, { errors: ["cipher: message authentication failed"] });
      }
    }
    return rep(404, { errors: [] });
  };
  return { etat, jeton, fetch: fetchImitation };
}

const A = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const URL_BAO = "http://openbao.test:8200";
const MARQUEUR = () => `valeur-${randomUUID()}`;

let bao: ReturnType<typeof creerFauxBao>;
const coffreAvec = (role: string) => creerCoffre({ url: URL_BAO, jeton: bao.jeton(role), fetch: bao.fetch });
let observees: Buffer[];
const enveloppe = () => creerEnveloppe({ url: URL_BAO, jeton: bao.jeton("api"), fetch: bao.fetch, observerCle: (b) => observees.push(b) });
beforeEach(() => { bao = creerFauxBao(); observees = []; });
const refus = async (p: Promise<unknown>, code?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ErreurCoffre);
  if (code) expect((e as ErreurCoffre).code).toBe(code);
  return e as ErreurCoffre;
};

describe("coffre : identifiants des clients (KV v2)", () => {
  it("[A-060] rangerIdentifiant renvoie une référence qui ne contient pas la valeur", async () => {
    const v = MARQUEUR();
    const ref = await coffreAvec("api").rangerIdentifiant(A, "boite-mail", v);
    expect(ref).toMatch(new RegExp(`^bao:clients/${A}/[0-9a-f-]{36}$`));
    expect(ref).not.toContain(v);
  });
  it("[A-060] la valeur ne voyage que dans le corps de la requête, jamais dans l'adresse ni dans l'état", async () => {
    const v = MARQUEUR();
    const ref = await coffreAvec("api").rangerIdentifiant(A, "boite-mail", v);
    expect(bao.etat.appels.filter((a) => a.url.includes(v))).toEqual([]);
    expect(bao.etat.appels.filter((a) => a.corps.includes(v)).length).toBe(1);
    expect(JSON.stringify(await coffreAvec("equipe").lireEtat(A, ref))).not.toContain(v);
  });
  it("[C-011] la valeur se relit avec le jeton courtier et seulement avec lui", async () => {
    const v = MARQUEUR();
    const ref = await coffreAvec("api").rangerIdentifiant(A, "boite-mail", v);
    expect(await coffreAvec("courtier").lireValeur(A, ref)).toBe(v);
    await refus(coffreAvec("api").lireValeur(A, ref), "refuse");
    await refus(coffreAvec("equipe").lireValeur(A, ref), "refuse");
    await refus(creerCoffre({ url: URL_BAO, jeton: "jeton-inconnu", fetch: bao.fetch }).lireValeur(A, ref), "refuse");
  });
  it("[A-005] @isolation le jeton equipe lit l'état et la date d'expiration et reçoit 403 sur la valeur", async () => {
    const ref = await coffreAvec("api").rangerIdentifiant(A, "boite-mail", MARQUEUR(), { expireLe: "2027-01-31" });
    expect(await coffreAvec("equipe").lireEtat(A, ref)).toEqual({ nom: "boite-mail", etat: "present", expireLe: "2027-01-31" });
    await refus(coffreAvec("equipe").lireValeur(A, ref), "refuse");
    expect(bao.etat.appels.at(-1)?.url).toContain("/clients/data/");
  });
  it("[C-011] @isolation une référence du client A demandée pour le client B est refusée sans appel réseau", async () => {
    const ref = await coffreAvec("api").rangerIdentifiant(A, "x", MARQUEUR());
    const avant = bao.etat.appels.length;
    await refus(coffreAvec("courtier").lireValeur(B, ref), "reference_etrangere");
    await refus(coffreAvec("equipe").lireEtat(B, ref), "reference_etrangere");
    expect(bao.etat.appels.length).toBe(avant);
  });
  it.each([
    [`bao:clients/${A}/../${B}/${randomUUID()}`],
    [`bao:clients/${A}/%2e%2e/${B}/${randomUUID()}`],
    [`bao:clients/${A}/${randomUUID()}/`],
    [`bao:clients/${A}/*`],
    [`bao:clients/${A}/${randomUUID()}?version=1`],
    [`bao:clients/${A}/${randomUUID()}#x`],
    [`clients/${A}/${randomUUID()}`],
    [`bao:clients/${A}/pas-un-uuid`],
    [`bao:transit/keys/cli-${A}`],
    [`bao:clients/${A}/${randomUUID()}\n`],
  ])("[C-011] @isolation référence piégée refusée sans appel réseau : %s", async (ref) => {
    await refus(coffreAvec("courtier").lireValeur(A, ref));
    await refus(coffreAvec("equipe").lireEtat(A, ref));
    expect(bao.etat.appels).toEqual([]);
  });
  it.each(["", "*", "a/b", "../x", `${A}\n`, `${A}/..`, "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6", "+"])(
    "[C-011] @isolation identifiant de client mal formé %j refusé partout, sans appel réseau",
    async (t) => {
      const c = coffreAvec("api"), e = enveloppe();
      await refus(c.rangerIdentifiant(t, "x", "v"), "tenant_invalide");
      await refus(c.lireEtat(t, `bao:clients/${t}/${randomUUID()}`), "tenant_invalide");
      await refus(e.creerCleClient(t), "tenant_invalide");
      await refus(e.chiffrer(t, Buffer.from("x")), "tenant_invalide");
      await refus(e.detruireCleClient(t, `detruire-${t}`), "tenant_invalide");
      expect(bao.etat.appels).toEqual([]);
    },
  );
  it("[C-011] OpenBao scellé → erreur coffre_scelle, jamais une valeur de repli", async () => {
    const ref = await coffreAvec("api").rangerIdentifiant(A, "x", MARQUEUR());
    const e = enveloppe();
    await e.creerCleClient(A);
    const env = await e.chiffrer(A, Buffer.from("texte"));
    bao.etat.scelle = true;
    await refus(coffreAvec("api").rangerIdentifiant(A, "x", "v"), "coffre_scelle");
    await refus(coffreAvec("equipe").lireEtat(A, ref), "coffre_scelle");
    await refus(coffreAvec("courtier").lireValeur(A, ref), "coffre_scelle");
    await refus(e.creerCleClient(A), "coffre_scelle");
    await refus(e.chiffrer(A, Buffer.from("x")), "coffre_scelle");
    await refus(e.dechiffrer(A, env), "coffre_scelle");
    await refus(e.detruireCleClient(A, `detruire-${A}`), "coffre_scelle");
  });
  it("[C-011] panne réseau ou réponse 500 → coffre_indisponible, sans jeton ni valeur dans l'erreur", async () => {
    const v = MARQUEUR();
    const jeton = bao.jeton("api");
    const c = creerCoffre({ url: URL_BAO, jeton, fetch: bao.fetch });
    bao.etat.panne = true;
    const e = await refus(c.rangerIdentifiant(A, "x", v), "coffre_indisponible");
    for (const t of [e.message, String(e.stack), JSON.stringify(e), String(e.cause ?? "")]) {
      expect(t).not.toContain(v);
      expect(t).not.toContain(jeton);
    }
    const c500 = creerCoffre({ url: URL_BAO, jeton, fetch: async () => new Response(`erreur ${jeton} ${v}`, { status: 500 }) });
    const e2 = await refus(c500.rangerIdentifiant(A, "x", v), "coffre_indisponible");
    expect(`${e2.message}${JSON.stringify(e2)}${String(e2.cause ?? "")}`).not.toMatch(new RegExp(`${jeton}|${v}`));
  });
  it("[A-005] une réponse 403 ne recopie ni la valeur ni le jeton dans l'erreur", async () => {
    const v = MARQUEUR(), jeton = bao.jeton("equipe");
    const e = await refus(creerCoffre({ url: URL_BAO, jeton, fetch: bao.fetch }).rangerIdentifiant(A, "x", v), "refuse");
    expect(`${e.message}${e.stack}${JSON.stringify(e)}`).not.toMatch(new RegExp(`${jeton}|${v}`));
  });
});

describe("enveloppe : une clé par client (C-012)", () => {
  it("[C-012] deux chiffrements du même texte donnent deux clés de données différentes", async () => {
    const e = enveloppe();
    await e.creerCleClient(A);
    const t = Buffer.from("même texte");
    const un = await e.chiffrer(A, t), deux = await e.chiffrer(A, t);
    expect(un.cleChiffree).not.toBe(deux.cleChiffree);
    expect(Buffer.compare(un.chiffre, deux.chiffre)).not.toBe(0);
    expect((await e.dechiffrer(A, un)).toString()).toBe("même texte");
    expect(un.version).toBe(1);
  });
  it("[C-012] la clé client est créée non exportable, en aes256-gcm96", async () => {
    await enveloppe().creerCleClient(A);
    const creation = bao.etat.appels.find((a) => a.url.endsWith(`/v1/transit/keys/cli-${A}`));
    expect(JSON.parse(creation?.corps ?? "{}")).toMatchObject({ type: "aes256-gcm96", exportable: false });
  });
  it("[C-012] @isolation un chiffré du client A ne se déchiffre pas avec la clé du client B", async () => {
    const e = enveloppe();
    await e.creerCleClient(A);
    await e.creerCleClient(B);
    const env = await e.chiffrer(A, Buffer.from("secret du client A"));
    await refus(e.dechiffrer(B, env));
    // Même une enveloppe où le coffre déchiffrerait la clé (cas d'une clé partagée par erreur) reste liée au client par les données associées.
    bao.etat.cles.set(`cli-${B}`, { secret: bao.etat.cles.get(`cli-${A}`)!.secret, supprimable: false });
    await refus(e.dechiffrer(B, env));
  });
  it("[C-012] après detruireCleClient, le déchiffrement échoue pour toujours", async () => {
    const e = enveloppe();
    await e.creerCleClient(A);
    const env = await e.chiffrer(A, Buffer.from("à perdre"));
    await e.detruireCleClient(A, `detruire-${A}`);
    await refus(e.dechiffrer(A, env));
    await refus(e.chiffrer(A, Buffer.from("x")));
    expect(bao.etat.cles.has(`cli-${A}`)).toBe(false);
  });
  it("[C-012] @isolation detruireCleClient exige la confirmation exacte et ne touche pas la clé d'un autre client", async () => {
    const e = enveloppe();
    await e.creerCleClient(A);
    await e.creerCleClient(B);
    for (const c of ["", "oui", `detruire-${B}`, `detruire-${A} `, `DETRUIRE-${A}`]) await refus(e.detruireCleClient(A, c), "confirmation_absente");
    expect(bao.etat.cles.has(`cli-${A}`)).toBe(true);
    await e.detruireCleClient(A, `detruire-${A}`);
    expect(bao.etat.cles.has(`cli-${B}`)).toBe(true);
  });
  it("[C-012] la clé de données en clair est remise à zéro après usage, aussi en cas d'échec", async () => {
    const e = enveloppe();
    await e.creerCleClient(A);
    const env = await e.chiffrer(A, Buffer.from("x"));
    await e.dechiffrer(A, env);
    expect(observees.length).toBe(2);
    for (const b of observees) expect(b.length === 32 && b.every((o) => o === 0)).toBe(true);
    observees = [];
    await refus(e.dechiffrer(A, { ...env, chiffre: Buffer.concat([env.chiffre.subarray(0, 5), Buffer.from([env.chiffre[5]! ^ 1]), env.chiffre.subarray(6)]) }));
    expect(observees.length).toBe(1);
    expect(observees[0]!.every((o) => o === 0)).toBe(true);
  });
  it("[C-012] un chiffré, une clé chiffrée ou une version falsifiés sont refusés sans sortie partielle", async () => {
    const e = enveloppe();
    await e.creerCleClient(A);
    const env = await e.chiffrer(A, Buffer.from("intact"));
    const bascule = (b: Buffer, i: number) => { const c = Buffer.from(b); c[i] = (c[i] ?? 0) ^ 0xff; return c; };
    for (const i of [0, 11, 12, env.chiffre.length - 1]) await refus(e.dechiffrer(A, { ...env, chiffre: bascule(env.chiffre, i) }));
    await refus(e.dechiffrer(A, { ...env, chiffre: env.chiffre.subarray(0, 20) }));
    await refus(e.dechiffrer(A, { ...env, cleChiffree: "vault:v1:AAAA" }));
    await refus(e.dechiffrer(A, { ...env, cleChiffree: "n'importe quoi" }));
    await refus(e.dechiffrer(A, { ...env, version: 2 }));
    await refus(e.dechiffrer(A, { ...env, version: 0 }));
    expect((await e.dechiffrer(A, env)).toString()).toBe("intact");
  });
  it("[C-012] une clé de données malformée renvoyée par le coffre est refusée : jamais de chiffrement avec une clé faible", async () => {
    const e = enveloppe();
    await e.creerCleClient(A);
    const cas: ((p: string, c: string) => Record<string, unknown>)[] = [
      (_p, c) => ({ plaintext: Buffer.alloc(16, 7).toString("base64"), ciphertext: c }),
      (_p, c) => ({ plaintext: "", ciphertext: c }),
      (_p, c) => ({ ciphertext: c }),
      (p) => ({ plaintext: p }),
      (p, c) => ({ plaintext: `!!${p}`, ciphertext: c }),
      (p) => ({ plaintext: p, ciphertext: "texte-libre" }),
    ];
    for (const reponse of cas) {
      bao.etat.reponseDatakey = reponse;
      await refus(e.chiffrer(A, Buffer.from("x")));
    }
  });
});

// ---- Infrastructure : compose, configuration, politiques, script d'initialisation, brique ----
const compose = () => lireYaml(lireFichier("ops/socle/compose.openbao.yml")) as { services: { openbao: Record<string, unknown> }; volumes: Record<string, unknown> };
const brique = () => JSON.parse(lireFichier("ops/briques/openbao.json")) as Record<string, unknown>;
const script = () => lireFichier("ops/socle/openbao/initialiser.sh").split("\n");

describe("infrastructure OpenBao", () => {
  it("[A-060] compose.openbao.yml passe la garde du compose et épingle l'image par empreinte, la même que la brique", () => {
    const texte = lireFichier("ops/socle/compose.openbao.yml");
    expect(verifierCompose("compose.openbao.yml", texte)).toEqual([]);
    const image = String(compose().services.openbao.image);
    expect(image).toBe(`openbao/openbao:${String(brique().version)}@${String(brique().empreinte)}`);
  });
  it("[A-060] OpenBao tourne en mode serveur : jamais de mode dev, aucun port publié, réseau interne seul", () => {
    const s = compose().services.openbao;
    const commande = ([] as unknown[]).concat(s.command ?? []).map(String);
    expect(commande[0]).toBe("server");
    expect(commande.some((c) => c.includes("dev"))).toBe(false);
    expect(Object.keys((s.environment ?? {}) as object).filter((k) => /DEV/i.test(k))).toEqual([]);
    expect(s.ports).toBeUndefined();
    expect(s.networks).toEqual(["interne"]);
    expect(JSON.stringify(s.volumes)).toContain("openbao-donnees");
    expect(compose().volumes).toHaveProperty("openbao-donnees");
  });
  it("[A-060] le contrôle de santé accepte un coffre scellé ou non initialisé (sinon impossible de tester le scellement)", () => {
    const test = JSON.stringify(compose().services.openbao.healthcheck);
    expect(test).toContain("sealedcode=200");
    expect(test).toContain("uninitcode=200");
  });
  it("[A-060] config.hcl : stockage intégré (raft), interface web fermée, mlock actif, pas de mode dev", () => {
    const c = lireHcl(lireFichier("ops/socle/openbao/config.hcl"));
    const storage = c.blocs.find((b) => b.type === "storage");
    expect(storage?.etiquettes).toEqual(["raft"]);
    expect(String(storage?.blocs.length ? "" : storage?.attrs.path)).toMatch(/^\/openbao\//);
    expect(c.blocs.filter((b) => b.type === "listener").map((b) => b.etiquettes[0])).toEqual(["tcp"]);
    expect(c.attrs.ui).not.toBe(true);
    expect(c.attrs.disable_mlock).not.toBe(true);
    expect(JSON.stringify(c)).not.toMatch(/dev/i);
  });
  it("[C-011] politiques : seul le courtier lit une valeur ; l'api n'en relit jamais ; l'équipe ne voit que les métadonnées", () => {
    const peut = (role: string, chemin: string, cap: string) => politique(role).some((d) => chemin_correspond(d.chemin, chemin) && d.capacites.includes(cap));
    const valeur = `clients/data/${A}/${randomUUID()}`, meta = `clients/metadata/${A}/${randomUUID()}`;
    expect(peut("courtier", valeur, "read")).toBe(true);
    expect(politique("courtier").flatMap((d) => d.capacites).filter((c) => c !== "read")).toEqual([]);
    expect(peut("api", valeur, "read")).toBe(false);
    expect(peut("api", valeur, "list")).toBe(false);
    expect(peut("api", meta, "read")).toBe(true);
    expect(peut("equipe", valeur, "read")).toBe(false);
    expect(peut("equipe", meta, "read")).toBe(true);
    for (const cap of ["create", "update", "delete", "list", "patch"]) expect(peut("equipe", meta, cap)).toBe(false);
    expect(politique("equipe").filter((d) => d.chemin.startsWith("transit"))).toEqual([]);
  });
  it("[C-012] politiques : l'api ne touche qu'aux clés cli-*, jamais en lecture de clé ; aucune politique ne donne sudo ni le chemin racine", () => {
    for (const r of ["api", "courtier", "equipe"]) {
      for (const d of politique(r)) {
        expect(d.capacites).not.toContain("sudo");
        expect(d.chemin).not.toMatch(/^(sys|auth|\*|\+)/);
        expect(d.chemin.startsWith("clients/") || d.chemin.startsWith("transit/")).toBe(true);
      }
    }
    const api = politique("api");
    expect(api.filter((d) => d.chemin.startsWith("transit/")).every((d) => /\/cli-\*$/.test(d.chemin))).toBe(true);
    expect(api.some((d) => d.chemin.startsWith("transit/export") || d.chemin.startsWith("transit/backup"))).toBe(false);
    expect(api.some((d) => d.chemin === "transit/keys/cli-*" && d.capacites.includes("read"))).toBe(false);
    expect(api.some((d) => chemin_correspond(d.chemin, "transit/keys/autre") )).toBe(false);
  });
  it("[A-005] initialiser.sh : syntaxe valide, pas de trace, masque avant usage, fichier privé effacé, jeton racine révoqué", () => {
    const l = script();
    const texte = l.join("\n");
    expect(execFileSync("bash", ["-n", fileURLToPath(new URL("../../../../ops/socle/openbao/initialiser.sh", import.meta.url))]).length).toBe(0);
    expect(l[0]).toBe("#!/usr/bin/env bash");
    expect(texte).toContain("set -euo pipefail");
    expect(texte).not.toMatch(/set\s+-\w*x|xtrace|-dev\b|BAO_DEV/);
    expect(texte).toContain("umask 077");
    expect(texte).toMatch(/trap .*(rm|shred).* EXIT/);
    expect(texte).toContain("-key-shares=5");
    expect(texte).toContain("-key-threshold=3");
    const iMasque = l.findIndex((x) => x.includes("::add-mask::"));
    const iInit = l.findIndex((x) => x.includes("operator init"));
    expect(iMasque).toBeGreaterThan(-1);
    expect(iInit).toBeGreaterThan(-1);
    const iRevoque = l.findIndex((x) => x.includes("token revoke"));
    expect(iRevoque).toBeGreaterThan(iInit);
    // Toute ligne qui écrit une variable sur la sortie standard est un masque, une redirection vers le fichier privé ou un texte sans variable.
    const bavardes = l.filter((x) => /^\s*(echo|printf|cat)\b/.test(x) && x.includes("$") && !x.includes("::add-mask::") && !/>\s*"?\$/.test(x));
    expect(bavardes).toEqual([]);
    expect(texte).not.toMatch(/-format=json[^\n]*\|\s*tee|\btee\b/);
  });
  it("[A-060] brique openbao : licence MPL-2.0, restée chez AXION IA, empreinte sha256, version exacte", () => {
    const b = brique();
    expect(b).toMatchObject({ nom: "openbao", image: "openbao/openbao", licence: "MPL-2.0", livree: false, lieu: "local" });
    expect(String(b.empreinte)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(String(b.version)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(String(b.source)).toMatch(/^https:\/\//);
    const schema = JSON.parse(lireFichier("ops/briques/schema.json")) as { required: string[]; properties: object };
    expect(Object.keys(b).sort()).toEqual(expect.arrayContaining(schema.required));
    expect(Object.keys(b).filter((k) => !(k in schema.properties))).toEqual([]);
  });
});
