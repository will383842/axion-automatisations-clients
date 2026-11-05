import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { nomBaseDe } from "../provisionnement/etapes-base.js";
import { chiffrerFlux } from "./chiffrement-flux.js";
import { cheminDump } from "./dump-client.js";
import { preparerRestauration, type InstanceJetable, type PortsRestauration, type Restauration } from "./restaurer-client.js";

// Faux OpenBao : une clé transit par client ; détruire la clé d'un client rend ses dumps illisibles.
function monde() {
  const detruites = new Set<string>(); const registre = new Map<string, { tenant: string; cle: Buffer }>();
  const fetch = (async (url: string, init: { body?: string }) => {
    const m = /^transit\/(datakey\/plaintext|decrypt)\/cli-([0-9a-f-]{36})$/.exec(new URL(url).pathname.replace("/v1/", ""));
    if (!m || detruites.has(m[2]!)) return new Response("{}", { status: 400 });
    if (m[1] === "decrypt") { const e = registre.get(JSON.parse(init.body!).ciphertext); return !e || e.tenant !== m[2] ? new Response("{}", { status: 400 }) : Response.json({ data: { plaintext: e.cle.toString("base64") } }); }
    const cle = randomBytes(32); const ct = `vault:v1:${randomBytes(9).toString("base64")}`;
    registre.set(ct, { tenant: m[2]!, cle: Buffer.from(cle) });
    return Response.json({ data: { plaintext: cle.toString("base64"), ciphertext: ct } });
  }) as unknown as typeof globalThis.fetch;
  const bao = { url: "http://bao.test", jeton: "jeton-de-test", fetch };
  async function chiffrer(tenantId: string, clair: string): Promise<Buffer> {
    const r = (await (await fetch(`http://bao.test/v1/transit/datakey/plaintext/cli-${tenantId}`, { body: "{}" } as never)).json()) as { data: { plaintext: string; ciphertext: string } };
    const out: Buffer[] = []; for await (const p of chiffrerFlux(Readable.from([Buffer.from(clair)]), Buffer.from(r.data.plaintext, "base64"), { versionCle: 1, cleChiffree: r.data.ciphertext }, tenantId)) out.push(p);
    return Buffer.concat(out);
  }
  return { bao, detruire: (t: string) => detruites.add(t), chiffrer };
}

function ports(m: ReturnType<typeof monde>, dumps: Map<string, Buffer>) {
  const j = { creations: 0, bases: new Map<string, { roles: string[]; contenu: string }>(), retirees: [] as string[], instances: [] as { horodatage: string; detruite: boolean }[], enregistrees: [] as Restauration[] };
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const p: PortsRestauration = {
    bao: m.bao,
    async empreinteEnregistree(t, date) { const d = dumps.get(cheminDump(t, date)); return d ? sha(d) : undefined; },
    lireDump: (c) => Readable.from(dumps.has(c) ? [dumps.get(c)!] : []),
    async demarrerInstanceJetable(horodatage): Promise<InstanceJetable> {
      const i = { horodatage, detruite: false }; j.instances.push(i);
      return { dumper: (nom) => Readable.from([Buffer.from(`copie-instant:${horodatage}:${nom}`)]), async detruire() { i.detruite = true; } };
    },
    async numeroSuivant() { return 3; },
    async rolesDuClient(t) { return [`${nomBaseDe(t)}_app`, `${nomBaseDe(t)}_lecture`]; },
    async creerBaseTemporaire(nom, roles) { j.creations++; j.bases.set(nom, { roles, contenu: "" }); },
    async charger(nom, flux) { const o: Buffer[] = []; for await (const x of flux) o.push(x as Buffer); j.bases.get(nom)!.contenu = Buffer.concat(o).toString(); },
    async retirerBaseTemporaire(nom) { j.retirees.push(nom); j.bases.delete(nom); },
    async enregistrer(r) { j.enregistrees.push(r); },
  };
  return { p, j };
}

describe("restaurer-client", () => {
  it("[C-048] un seul client est restauré depuis son dump sans toucher aux autres", async () => {
    const m = monde(); const a = randomUUID(); const b = randomUUID();
    const { p, j } = ports(m, new Map([[cheminDump(a, "2026-11-01"), await m.chiffrer(a, "donnees-de-A")]]));
    const r = await preparerRestauration(p, a, { depuis: "dump", date: "2026-11-01" });
    expect(r.nomBase).toBe(`${nomBaseDe(a)}_restau_3`);
    expect([...j.bases.keys()]).toEqual([r.nomBase]);
    expect(j.bases.get(r.nomBase)!.contenu).toBe("donnees-de-A");
    expect([...j.bases.keys()].some((n) => n.includes(nomBaseDe(b)))).toBe(false);
    expect(j.enregistrees).toHaveLength(1);
  });
  it("[A-240] la restauration à un instant précis passe par une instance jetable", async () => {
    const m = monde(); const a = randomUUID();
    const { p, j } = ports(m, new Map());
    const r = await preparerRestauration(p, a, { depuis: "instant", horodatage: "2026-11-02T10:00:00.000Z" });
    expect(j.instances).toEqual([{ horodatage: "2026-11-02T10:00:00.000Z", detruite: true }]);
    expect(j.bases.get(r.nomBase)!.contenu).toBe(`copie-instant:2026-11-02T10:00:00.000Z:${nomBaseDe(a)}`);
  });
  it("[A-240] l'instance jetable est détruite même si la copie échoue", async () => {
    const m = monde(); const a = randomUUID(); const { p, j } = ports(m, new Map());
    p.charger = async () => { throw new Error("copie_echouee"); };
    await expect(preparerRestauration(p, a, { depuis: "instant", horodatage: "2026-11-02T10:00:00.000Z" })).rejects.toThrow("copie_echouee");
    expect(j.instances[0]!.detruite).toBe(true);
    expect(j.retirees).toEqual([`${nomBaseDe(a)}_restau_3`]);
    expect(j.enregistrees).toHaveLength(0);
  });
  it("[C-536] @isolation la base restaurée de A n'est accessible qu'aux rôles de A ; elle ne lit ni n'écrase B", async () => {
    const m = monde(); const a = randomUUID(); const b = randomUUID();
    const { p, j } = ports(m, new Map([[cheminDump(a, "2026-11-01"), await m.chiffrer(a, "x")]]));
    const appeles: { nom: string; roles: string[] }[] = [];
    const creer = p.creerBaseTemporaire; p.creerBaseTemporaire = async (nom, roles) => { appeles.push({ nom, roles }); return creer(nom, roles); };
    const r = await preparerRestauration(p, a, { depuis: "dump", date: "2026-11-01" });
    // Verrouillée : aucun rôle du client (ni d'un autre) n'y entre tant qu'elle n'est pas basculée.
    expect(appeles).toEqual([{ nom: r.nomBase, roles: [] }]);
    expect(appeles.flatMap((x) => x.roles).some((x) => x.includes(nomBaseDe(b)))).toBe(false);
    expect(r.nomBase).not.toBe(nomBaseDe(a));
    expect(j.bases.has(nomBaseDe(a))).toBe(false);
  });
  it("[C-536] @isolation le dump d'un client ne se restaure pas sous un autre client", async () => {
    const m = monde(); const a = randomUUID(); const b = randomUUID();
    const { p, j } = ports(m, new Map([[cheminDump(b, "2026-11-01"), await m.chiffrer(a, "donnees-de-A")]]));
    await expect(preparerRestauration(p, b, { depuis: "dump", date: "2026-11-01" })).rejects.toBeDefined();
    // La clé est refusée AVANT toute écriture : aucune base temporaire n'a même été créée.
    expect(j.creations).toBe(0);
    expect(j.enregistrees).toHaveLength(0);
  });
  it("[C-048] le dump d'un client dont la clé est détruite ne se restaure pas", async () => {
    const m = monde(); const a = randomUUID();
    const { p, j } = ports(m, new Map([[cheminDump(a, "2026-11-01"), await m.chiffrer(a, "x")]]));
    m.detruire(a);
    await expect(preparerRestauration(p, a, { depuis: "dump", date: "2026-11-01" })).rejects.toBeDefined();
    expect(j.creations).toBe(0);
    expect(j.enregistrees).toHaveLength(0);
  });
  it("[C-048] une date ou un instant mal formés sont refusés avant tout travail", async () => {
    const m = monde(); const { p, j } = ports(m, new Map());
    await expect(preparerRestauration(p, randomUUID(), { depuis: "dump", date: "../autre" })).rejects.toThrow("source_invalide");
    await expect(preparerRestauration(p, randomUUID(), { depuis: "instant", horodatage: "hier" })).rejects.toThrow("source_invalide");
    expect(j.bases.size + j.instances.length).toBe(0);
  });
});

describe("restaurer-client : contrôle avant écriture", () => {
  const grand = "x".repeat(200_000); // plusieurs blocs
  it("[C-048] un dump altéré est refusé avant toute écriture (empreinte différente)", async () => {
    const m = monde(); const a = randomUUID(); const bon = await m.chiffrer(a, grand);
    const { p, j } = ports(m, new Map([[cheminDump(a, "2026-11-01"), bon]]));
    const alteré = Buffer.from(bon); alteré[alteré.length - 40]! ^= 1;
    p.lireDump = () => Readable.from([alteré]);
    await expect(preparerRestauration(p, a, { depuis: "dump", date: "2026-11-01" })).rejects.toThrow("empreinte_differente");
    expect(j.creations).toBe(0);
  });
  it("[C-048] un dump altéré dont l'empreinte a été refaite est refusé par la lecture à blanc", async () => {
    const m = monde(); const a = randomUUID(); const bon = await m.chiffrer(a, grand);
    const alteré = Buffer.from(bon); alteré[alteré.length - 40]! ^= 1;
    const { p, j } = ports(m, new Map([[cheminDump(a, "2026-11-01"), alteré]]));
    await expect(preparerRestauration(p, a, { depuis: "dump", date: "2026-11-01" })).rejects.toThrow("dechiffrement_impossible");
    expect(j.creations).toBe(0);
  });
  it("[C-048] un dump coupé est refusé avant toute écriture, avec ou sans empreinte à jour", async () => {
    const m = monde(); const a = randomUUID(); const bon = await m.chiffrer(a, grand);
    const coupe = bon.subarray(0, bon.length - 200);
    const e1 = ports(m, new Map([[cheminDump(a, "2026-11-01"), bon]]));
    e1.p.lireDump = () => Readable.from([coupe]);
    await expect(preparerRestauration(e1.p, a, { depuis: "dump", date: "2026-11-01" })).rejects.toThrow("empreinte_differente");
    const e2 = ports(m, new Map([[cheminDump(a, "2026-11-01"), coupe]]));
    await expect(preparerRestauration(e2.p, a, { depuis: "dump", date: "2026-11-01" })).rejects.toThrow("dechiffrement_impossible");
    expect(e1.j.creations + e2.j.creations).toBe(0);
  });
  it("[C-048] sans empreinte enregistrée, le dump n'est pas restauré", async () => {
    const m = monde(); const a = randomUUID();
    const { p, j } = ports(m, new Map([[cheminDump(a, "2026-11-01"), await m.chiffrer(a, "x")]]));
    p.empreinteEnregistree = async () => undefined;
    await expect(preparerRestauration(p, a, { depuis: "dump", date: "2026-11-01" })).rejects.toThrow("empreinte_absente");
    expect(j.creations).toBe(0);
  });
  it("[C-536] @isolation si le nettoyage échoue, l'erreur d'origine est gardée et la base temporaire reste verrouillée", async () => {
    const m = monde(); const a = randomUUID(); const { p, j } = ports(m, new Map());
    p.charger = async () => { throw new Error("copie_echouee"); };
    p.retirerBaseTemporaire = async () => { throw new Error("nettoyage_echoue"); };
    await expect(preparerRestauration(p, a, { depuis: "instant", horodatage: "2026-11-02T10:00:00.000Z" })).rejects.toThrow("copie_echouee");
    expect([...j.bases.values()].every((b) => b.roles.length === 0)).toBe(true);
    expect(j.instances[0]!.detruite).toBe(true);
    expect(j.enregistrees).toHaveLength(0);
  });
  it("[A-240] l'échec de destruction de l'instance ne masque pas l'erreur d'origine", async () => {
    const m = monde(); const a = randomUUID(); const { p } = ports(m, new Map());
    p.demarrerInstanceJetable = async () => ({ dumper: () => Readable.from([Buffer.from("x")]), detruire: async () => { throw new Error("destruction_echouee"); } });
    p.charger = async () => { throw new Error("copie_echouee"); };
    await expect(preparerRestauration(p, a, { depuis: "instant", horodatage: "2026-11-02T10:00:00.000Z" })).rejects.toThrow("copie_echouee");
  });
});
