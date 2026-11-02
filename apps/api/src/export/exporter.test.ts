import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Connexion } from "../donnees/service.js";
import { creerExporteur, dateExpiration, idTacheExport, type PortsExport } from "./exporter.js";
import { verifierExport } from "./manifeste.js";
import { lireZip } from "./zip-flux.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const D1 = "33333333-3333-4333-8333-333333333333";
const D2 = "44444444-4444-4444-8444-444444444444";
const MAINTENANT = new Date("2026-11-02T10:00:00Z");

type Table = { colonnes: string[]; lignes: Record<string, unknown>[] };
type Base = Record<string, Table>; // « schema.table »
const BASE_A: Base = {
  "commun.personnes": { colonnes: ["id", "tenant_id", "nom", "courriel_chiffre", "courriel_empreinte", "note"], lignes: [
    { id: "p1", tenant_id: A, nom: "Camille \"Cam\" Lemoine", courriel_chiffre: Buffer.from("chiffre-p1"), courriel_empreinte: Buffer.alloc(32, 1), note: "ligne 1\nligne 2, virgule" },
    { id: "p2", tenant_id: A, nom: "Élodie Marceau", courriel_chiffre: null, courriel_empreinte: null, note: null },
  ] },
  "a_devis.lignes": { colonnes: ["id", "tenant_id", "total"], lignes: [{ id: "l1", tenant_id: A, total: 12n }] },
  "trace.evenements": { colonnes: ["id", "tenant_id", "quand"], lignes: [{ id: "e1", tenant_id: A, quand: new Date("2026-10-01T08:00:00Z") }] },
  "commun.vide": { colonnes: ["id", "tenant_id"], lignes: [] },
};
const BASE_B: Base = { "commun.personnes": { colonnes: ["id", "tenant_id", "nom"], lignes: [{ id: "pb", tenant_id: B, nom: "Garage Fontaine" }] } };

function connexion(base: Base, vus: string[]): Connexion {
  return {
    async requete(texte, valeurs) {
      vus.push(texte);
      if (/information_schema\.tables/.test(texte)) return Object.keys(base).map((k) => ({ table_schema: k.split(".")[0], table_name: k.split(".")[1] }));
      if (/information_schema\.columns/.test(texte)) return base[`${valeurs[0]}.${valeurs[1]}`]!.colonnes.map((c) => ({ column_name: c }));
      const m = /FROM "([a-z0-9_]+)"\."([a-z0-9_]+)"/.exec(texte);
      if (!m || !/^\s*SELECT/i.test(texte) || /(INSERT|UPDATE|DELETE|DROP)/i.test(texte)) throw new Error("requete_inattendue");
      const t = base[`${m[1]}.${m[2]}`]!;
      const [limite, decalage] = valeurs as [number, number];
      return t.lignes.slice(decalage, decalage + limite).map((l) => Object.fromEntries(t.colonnes.map((c) => [c, l[c]])));
    },
    async fermer() {},
  };
}

function monter(bases: Record<string, Base> = { [A]: BASE_A, [B]: BASE_B }, options: { fichiers?: Record<string, Record<string, string>>; echec?: string } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const cle = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64");
  const etat = { requetes: [] as string[], ouvertures: [] as string[], fermees: 0, depots: new Map<string, Buffer>(), traces: [] as Record<string, unknown>[], deposeSous: [] as string[], dechiffres: [] as string[] };
  const ports: PortsExport = {
    async base(t) { return bases[t] ? { nomBase: `cli_${t.slice(0, 4)}`, etat: "active" } : undefined; },
    async ouvrir(nomBase, role) {
      etat.ouvertures.push(`${nomBase}/${role}`);
      const t = Object.keys(bases).find((x) => `cli_${x.slice(0, 4)}` === nomBase)!;
      const c = connexion(bases[t]!, etat.requetes);
      return { requete: c.requete, async fermer() { etat.fermees++; } };
    },
    fichiers: {
      async lister(t) { return Object.keys(options.fichiers?.[t] ?? {}); },
      async lire(t, k) { const v = options.fichiers?.[t]?.[k]; return v === undefined ? undefined : Buffer.from(v); },
    },
    async dechiffrer(t, octets, contexte) { etat.dechiffres.push(`${t}|${contexte.colonne}:${contexte.idLigne}`); return `clair-${Buffer.from(octets).toString()}`; },
    signature: {
      async signer(octets) { return `vault:v1:${sign(null, octets, privateKey).toString("base64")}`; },
      async clePublique() { return cle; },
    },
    async deposer(t, k, octets) { if (options.echec === "depot") throw new Error("depot_refuse"); etat.deposeSous.push(`${t}|${k}`); etat.depots.set(`${t}|${k}`, Buffer.from(octets)); },
    async tracer(e) { etat.traces.push(e); },
    maintenant: () => MAINTENANT,
  };
  return { ports, etat, cle };
}

describe("export complet du client", () => {
  it("[A-252] l'export contient un CSV et un JSON par table et les fichiers dans un ZIP", async () => {
    const { ports, etat, cle } = monter(undefined, { fichiers: { [A]: { "devis/d1.pdf": "pdf-a", "photo.png": "png-a" } } });
    const r = await creerExporteur(ports).exporter({ tenantId: A, demande: D1, acteur: "client" });
    expect(etat.deposeSous).toEqual([`${A}|exports/${D1}.zip`]);
    expect(r.cle).toBe(`exports/${D1}.zip`);
    const zip = lireZip(etat.depots.get(`${A}|exports/${D1}.zip`)!);
    const noms = [...zip.keys()];
    for (const t of ["commun/personnes", "a_devis/lignes", "trace/evenements", "commun/vide"]) {
      expect(noms, t).toContain(`donnees/${t}.csv`);
      expect(noms, t).toContain(`donnees/${t}.jsonl`);
    }
    expect(noms).toEqual(expect.arrayContaining(["fichiers/devis/d1.pdf", "fichiers/photo.png", "manifeste.json", "manifeste.sig", "verifier.txt"]));
    expect(zip.get("fichiers/photo.png")!.toString()).toBe("png-a");
    // CSV RFC 4180 : CRLF, guillemets doublés, champ à virgule ou saut de ligne entre guillemets ; le chiffré est rendu en clair, l'empreinte de recherche n'est pas exportée.
    expect(zip.get("donnees/commun/personnes.csv")!.toString("utf8")).toBe(
      'id,tenant_id,nom,courriel,note\r\np1,' + A + ',"Camille ""Cam"" Lemoine",clair-chiffre-p1,"ligne 1\nligne 2, virgule"\r\np2,' + A + ",Élodie Marceau,,\r\n",
    );
    expect(zip.get("donnees/commun/vide.csv")!.toString()).toBe("id,tenant_id\r\n");
    const lignes = zip.get("donnees/commun/personnes.jsonl")!.toString("utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lignes[0]).toMatchObject({ id: "p1", courriel: "clair-chiffre-p1", note: "ligne 1\nligne 2, virgule" });
    expect(lignes[1]).toMatchObject({ courriel: null });
    expect(JSON.stringify(lignes)).not.toContain("courriel_empreinte");
    expect(zip.get("donnees/a_devis/lignes.jsonl")!.toString()).toBe('{"id":"l1","tenant_id":"' + A + '","total":"12"}\n');
    expect(etat.dechiffres).toEqual([`${A}|personnes.courriel_chiffre:p1`]);
    // Signé : l'export se vérifie avec la clé publique, et verifier.txt la donne.
    expect(verifierExport(zip, cle)).toEqual({ ok: true });
    expect(zip.get("verifier.txt")!.toString("utf8")).toContain(cle);
  });

  it("[B-371] l'export est demandable à tout moment par le client, sans fin de contrat", async () => {
    const { ports, etat } = monter();
    const r = await creerExporteur(ports).exporter({ tenantId: A, demande: D1, acteur: "client" });
    expect(r.expireLe).toEqual(new Date("2026-12-02T10:00:00Z"));
    expect(etat.traces).toEqual([{ type: "export_cree", tenantId: A, demande: D1, acteur: "client", expireLe: "2026-12-02T10:00:00.000Z", octets: r.octets }]);
    expect(JSON.stringify(etat.traces)).not.toContain("Camille");
    // Une seconde demande l'est aussi : deux exports distincts.
    await creerExporteur(ports).exporter({ tenantId: A, demande: D2, acteur: "client" });
    expect(etat.deposeSous).toEqual([`${A}|exports/${D1}.zip`, `${A}|exports/${D2}.zip`]);
  });

  it("[A-252] l'export reste disponible 30 jours et la tâche a un identifiant sans doublon", () => {
    expect(dateExpiration(MAINTENANT)).toEqual(new Date("2026-12-02T10:00:00Z"));
    expect(idTacheExport(A, D1)).toBe(`export:${A}:${D1}`);
    expect(() => idTacheExport("pas-un-client", D1)).toThrow("identifiant_invalide");
    expect(() => idTacheExport(A, "x:y")).toThrow("identifiant_invalide");
  });

  it("[C-536] @isolation un export ne contient aucune ligne d'un autre client", async () => {
    const { ports, etat } = monter();
    await creerExporteur(ports).exporter({ tenantId: B, demande: D1, acteur: "client" });
    const zip = lireZip(etat.depots.get(`${B}|exports/${D1}.zip`)!);
    const tout = [...zip.values()].map((v) => v.toString("utf8")).join("\n");
    expect(tout).toContain("Garage Fontaine");
    for (const interdit of ["Lemoine", "Marceau", A, "clair-chiffre"]) expect(tout, interdit).not.toContain(interdit);
    // Une seule base ouverte, en lecture, et refermée.
    expect(etat.ouvertures).toEqual(["cli_2222/lecture"]);
    expect(etat.fermees).toBe(1);
  });

  it("[C-536] @isolation une ligne d'un autre client trouvée dans la base arrête l'export, sans rien déposer", async () => {
    const piegee: Base = { "commun.personnes": { colonnes: ["id", "tenant_id", "nom"], lignes: [{ id: "p1", tenant_id: A, nom: "Atelier Bertin" }, { id: "px", tenant_id: B, nom: "Garage Fontaine" }] } };
    const { ports, etat } = monter({ [A]: piegee });
    await expect(creerExporteur(ports).exporter({ tenantId: A, demande: D1, acteur: "client" })).rejects.toThrow("isolation_violee");
    expect(etat.depots.size).toBe(0);
    expect(etat.traces).toEqual([]);
    expect(etat.fermees).toBe(1);
  });

  it("[C-536] @isolation deux exports en même temps de clients différents ne partagent ni base ni fichiers", async () => {
    const { ports, etat } = monter(undefined, { fichiers: { [A]: { "a.txt": "fichier-de-a" }, [B]: { "b.txt": "fichier-de-b" } } });
    const x = creerExporteur(ports);
    await Promise.all([x.exporter({ tenantId: A, demande: D1, acteur: "client" }), x.exporter({ tenantId: B, demande: D1, acteur: "client" })]);
    const pourA = lireZip(etat.depots.get(`${A}|exports/${D1}.zip`)!);
    const pourB = lireZip(etat.depots.get(`${B}|exports/${D1}.zip`)!);
    expect([...pourA.keys()].filter((n) => n.startsWith("fichiers/"))).toEqual(["fichiers/a.txt"]);
    expect([...pourB.keys()].filter((n) => n.startsWith("fichiers/"))).toEqual(["fichiers/b.txt"]);
    expect(etat.fermees).toBe(2);
  });

  it("[C-536] @isolation un client sans base active n'obtient rien et ne le dit pas autrement", async () => {
    const { ports, etat } = monter({ [A]: BASE_A });
    await expect(creerExporteur(ports).exporter({ tenantId: B, demande: D1, acteur: "client" })).rejects.toThrow("introuvable");
    expect(etat.ouvertures).toEqual([]);
    await expect(creerExporteur({ ...ports, base: async () => ({ nomBase: "cli_x", etat: "en_creation" }) }).exporter({ tenantId: A, demande: D1, acteur: "client" })).rejects.toThrow("introuvable");
  });

  it("[A-252] un échec (dépôt, déchiffrement) ne laisse ni export à moitié déposé ni trace de réussite", async () => {
    const m = monter(undefined, { echec: "depot" });
    await expect(creerExporteur(m.ports).exporter({ tenantId: A, demande: D1, acteur: "client" })).rejects.toThrow("depot_refuse");
    expect(m.etat.traces).toEqual([]);
    expect(m.etat.fermees).toBe(1);
    const n = monter();
    await expect(creerExporteur({ ...n.ports, dechiffrer: async () => { throw new Error("dechiffrement_impossible"); } }).exporter({ tenantId: A, demande: D1, acteur: "client" })).rejects.toThrow("dechiffrement_impossible");
    expect(n.etat.depots.size).toBe(0);
  });

  it("[A-252] les noms de schéma ou de table inattendus sont refusés, la lecture reste en SELECT", async () => {
    const mauvaise: Base = { 'commun.x"; DROP TABLE y; --': { colonnes: ["id"], lignes: [] } };
    const { ports } = monter({ [A]: mauvaise });
    await expect(creerExporteur(ports).exporter({ tenantId: A, demande: D1, acteur: "client" })).rejects.toThrow("nom_invalide");
    const ok = monter();
    await creerExporteur(ok.ports).exporter({ tenantId: A, demande: D1, acteur: "client" });
    expect(ok.etat.requetes.every((q) => /^\s*SELECT/i.test(q))).toBe(true);
  });
});
