import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { dechiffrerFlux } from "./chiffrement-flux.js";
import { cheminDump, dumperClient, planifierNuit, retirerAnciensDumps, type BaseADumper, type Cible, type DepsDump } from "./dump-client.js";

// Faux OpenBao : une clé transit par client, jamais partagée. « chiffrer » une clé de données = la mettre dans un registre (vault:v1:<id>).
function fauxCoffre() {
  const detruites = new Set<string>();
  const registre = new Map<string, { tenant: string; cle: Buffer }>();
  const fetch = (async (url: string, init: { body?: string }) => {
    const chemin = new URL(url).pathname.replace("/v1/", "");
    const m = /^transit\/(datakey\/plaintext|decrypt)\/cli-([0-9a-f-]{36})$/.exec(chemin);
    if (!m || detruites.has(m[2]!)) return new Response("{}", { status: 400 });
    if (m[1] === "decrypt") {
      const e = registre.get(JSON.parse(init.body!).ciphertext);
      return !e || e.tenant !== m[2] ? new Response("{}", { status: 400 }) : Response.json({ data: { plaintext: e.cle.toString("base64") } });
    }
    const cle = randomBytes(32); const ct = `vault:v1:${randomBytes(9).toString("base64")}`;
    registre.set(ct, { tenant: m[2]!, cle: Buffer.from(cle) });
    return Response.json({ data: { plaintext: cle.toString("base64"), ciphertext: ct } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, detruire: (t: string) => detruites.add(t), bao: { url: "http://bao.test", jeton: "jeton-de-test", fetch } };
}

function fausseCible() {
  const fichiers = new Map<string, Buffer>(); const retraits: string[] = [];
  const cible: Cible = {
    async deposer(chemin, flux) {
      if (fichiers.has(chemin)) throw new Error("existe_deja");
      const parts: Buffer[] = []; for await (const p of flux) parts.push(p);
      fichiers.set(chemin, Buffer.concat(parts));
    },
    async lister(prefixe) { return [...fichiers.keys()].filter((c) => c.startsWith(prefixe)); },
    async retirer(chemin) { retraits.push(chemin); fichiers.delete(chemin); },
  };
  return { cible, fichiers, retraits };
}

const base = (etat = "active"): BaseADumper => { const tenantId = randomUUID(); return { tenantId, nomBase: `cli_${tenantId.replaceAll("-", "")}`, etat }; };
const MARQUEUR = `MARQUEUR-${randomBytes(8).toString("hex")}`;
const lancerDump = (nomBase: string) => Readable.from([Buffer.from(`PGDMP ${nomBase} `), Buffer.from(MARQUEUR), Buffer.alloc(200_000, 1)]);

function montage(extra: Partial<DepsDump> = {}) {
  const coffre = fauxCoffre(); const c = fausseCible(); const marques: string[] = [];
  const deps: DepsDump = { bao: coffre.bao, lancerDump, cible: c.cible, marquerSauvegarde: async (t) => { marques.push(t); }, ...extra };
  return { coffre, c, marques, deps };
}
async function relire(m: ReturnType<typeof montage>, b: BaseADumper, chemin: string, tenant = b.tenantId): Promise<Buffer> {
  const parts: Buffer[] = [];
  const ouvrir = async (e: { cleChiffree: string }) => {
    const r = await m.coffre.fetch(`http://bao.test/v1/transit/decrypt/cli-${tenant}`, { body: JSON.stringify({ ciphertext: e.cleChiffree }) } as never);
    if (!r.ok) throw new Error("dechiffrement_impossible");
    return Buffer.from(((await r.json()) as { data: { plaintext: string } }).data.plaintext, "base64");
  };
  for await (const p of dechiffrerFlux(Readable.from([m.c.fichiers.get(chemin)!]), tenant, ouvrir)) parts.push(p);
  return Buffer.concat(parts);
}

describe("dump de nuit par base client", () => {
  it("[A-238] chaque base client a son dump de la nuit, rangé sous clients/<id court>/<date>.dump.enc, avec empreinte et date de dernière sauvegarde", async () => {
    const m = montage(); const bases = [base(), base("gelee"), base()];
    for (const b of bases) {
      const r = await dumperClient(m.deps, b, "2026-11-02");
      expect(r.chemin).toBe(cheminDump(b.tenantId, "2026-11-02"));
      expect(r.chemin).toMatch(/^clients\/[0-9a-f]{12}\/2026-11-02\.dump\.enc$/);
      expect(r.empreinte).toBe(createHash("sha256").update(m.c.fichiers.get(r.chemin)!).digest("hex"));
    }
    expect(m.c.fichiers.size).toBe(3);
    expect(m.marques).toEqual(bases.map((b) => b.tenantId));
  });

  it("[A-238] la nuit planifie une tâche par base à sauvegarder, jobId stable (base et date), sans base en création ni effacée", async () => {
    const ajouts: { nom: string; opts: { jobId: string } }[] = [];
    const file = { add: async (nom: string, _d: unknown, opts: { jobId: string }) => { ajouts.push({ nom, opts }); } };
    const bs = [base(), base("gelee"), base("en_creation"), base("effacee")];
    await planifierNuit(file, bs, "2026-11-02");
    await planifierNuit(file, bs, "2026-11-02");
    expect(ajouts.map((a) => a.opts.jobId)).toEqual([bs[0]!, bs[1]!, bs[0]!, bs[1]!].map((b) => `dump-${b.nomBase}-2026-11-02`));
    expect(ajouts.every((a) => !a.opts.jobId.includes(":"))).toBe(true);
  });

  it("[A-238] un dump qui échoue n'est ni déposé en entier ni marqué comme sauvegardé", async () => {
    const m = montage({ lancerDump: () => Readable.from((async function* () { yield Buffer.from("PGDMP"); throw new Error("pg_dump_a_echoue"); })()) });
    await expect(dumperClient(m.deps, base(), "2026-11-02")).rejects.toThrow();
    expect(m.marques).toEqual([]);
  });

  it("[A-239] le dump est chiffré par une clé de données propre à ce dump, elle-même chiffrée par la clé du client", async () => {
    const m = montage(); const b = base();
    const hier = await dumperClient(m.deps, b, "2026-11-01");
    const jour = await dumperClient(m.deps, b, "2026-11-02");
    const e1 = m.c.fichiers.get(hier.chemin)!, e2 = m.c.fichiers.get(jour.chemin)!;
    expect(e1.includes(Buffer.from("vault:v1:"))).toBe(true);
    expect(e1.subarray(0, 120).equals(e2.subarray(0, 120))).toBe(false); // clé de données chiffrée différente à chaque dump
    expect((await relire(m, b, jour.chemin)).includes(Buffer.from(MARQUEUR))).toBe(true);
  });

  it("[A-244] @isolation le dump de A ne se déchiffre pas avec la clé de B", async () => {
    const m = montage(); const a = base(), b = base();
    const r = await dumperClient(m.deps, a, "2026-11-02");
    await expect(relire(m, a, r.chemin, b.tenantId)).rejects.toThrow("dechiffrement_impossible");
    expect(m.c.fichiers.get(r.chemin)!.includes(Buffer.from(b.tenantId))).toBe(false);
  });

  it("[A-244] @isolation la clé de données d'un client n'est jamais demandée au nom d'un autre", async () => {
    const demandes: string[] = []; const coffre = fauxCoffre();
    const m = montage({ bao: { ...coffre.bao, fetch: (async (u: string, i: unknown) => { demandes.push(new URL(u).pathname); return coffre.fetch(u as never, i as never); }) as never } });
    const a = base(), b = base();
    await dumperClient(m.deps, a, "2026-11-02"); await dumperClient(m.deps, b, "2026-11-02");
    expect(demandes).toEqual([`/v1/transit/datakey/plaintext/cli-${a.tenantId}`, `/v1/transit/datakey/plaintext/cli-${b.tenantId}`]);
  });

  it("[A-245] après destruction de la clé du client, son dump est illisible pour toujours (client fictif)", async () => {
    const m = montage(); const b = base();
    const r = await dumperClient(m.deps, b, "2026-11-02");
    expect((await relire(m, b, r.chemin)).length).toBeGreaterThan(0);
    m.coffre.detruire(b.tenantId);
    await expect(relire(m, b, r.chemin)).rejects.toThrow("dechiffrement_impossible");
  });

  it("[C-047] la sauvegarde de nuit ne contient en clair aucun marqueur de la base du client", async () => {
    const m = montage(); const b = base();
    const r = await dumperClient(m.deps, b, "2026-11-02");
    const depose = m.c.fichiers.get(r.chemin)!;
    expect(depose.includes(Buffer.from(MARQUEUR))).toBe(false);
    expect(depose.includes(Buffer.from("PGDMP"))).toBe(false);
  });

  it("[C-047] aucun fichier temporaire en clair pendant le dump", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "dump-sans-disque-")); const avant = process.env["TMPDIR"];
    process.env["TMPDIR"] = dossier;
    try { const m = montage(); await dumperClient(m.deps, base(), "2026-11-02"); } finally { if (avant === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = avant; }
    expect(readdirSync(dossier)).toEqual([]);
    // le code du dump n'écrit aucun fichier : aucune fonction d'écriture du module node:fs
    for (const f of ["dump-client.ts", "chiffrement-flux.ts"]) expect(readFileSync(new URL(`./${f}`, import.meta.url), "utf8")).not.toMatch(/node:fs|writeFile|createWriteStream|mkdtemp/);
  });

  it("[C-047] retrait d'un ancien dump : interrupteur fermé, rien n'est retiré", async () => {
    const m = montage(); const b = base();
    for (let j = 1; j <= 9; j++) await dumperClient(m.deps, b, `2026-0${j}-15`);
    const avant = m.c.fichiers.size;
    const ferme = await retirerAnciensDumps({ cible: m.c.cible, actif: false, gelees: new Set() }, b.tenantId, "2026-11-02");
    expect(ferme).toEqual({ retires: [], raison: "interrupteur_ferme" });
    expect(m.c.retraits).toEqual([]); expect(m.c.fichiers.size).toBe(avant);
  });

  it("[C-047] retrait ouvert : retire les dumps hors rétention d'un seul client, jamais en gel pour litige, jamais ceux d'un autre client", async () => {
    const m = montage(); const b = base(), autre = base();
    for (let j = 1; j <= 9; j++) { await dumperClient(m.deps, b, `2025-0${j}-15`); await dumperClient(m.deps, autre, `2025-0${j}-15`); }
    const gele = await retirerAnciensDumps({ cible: m.c.cible, actif: true, gelees: new Set([b.tenantId]) }, b.tenantId, "2026-11-02");
    expect(gele).toEqual({ retires: [], raison: "gel_litige" });
    const ok = await retirerAnciensDumps({ cible: m.c.cible, actif: true, gelees: new Set() }, b.tenantId, "2026-11-02");
    expect(ok.retires.length).toBeGreaterThan(0);
    expect(m.c.retraits.every((c) => c.startsWith(`clients/${b.tenantId.replaceAll("-", "").slice(0, 12)}/`))).toBe(true);
    expect([...m.c.fichiers.keys()].filter((c) => c.startsWith(`clients/${autre.tenantId.replaceAll("-", "").slice(0, 12)}/`)).length).toBe(9);
  });
});
