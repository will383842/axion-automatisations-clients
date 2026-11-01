import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPARTIMENT, copierVeille, enfilerCopie, type DepotVerrouille, type PortCopie } from "./copie-quotidienne.js";
import { empreinteDe, type LigneJournal } from "./contenu-canonique.js";
import type { LecteurJournal } from "./verifier.js";

// Copie quotidienne (T2-10) avec un stockage imité qui refuse, comme la brique, d'écrire une clé déjà présente.
const MAINTENANT = new Date("2026-11-01T02:30:00.000Z");
function stockage() {
  const objets = new Map<string, DepotVerrouille>();
  const port: PortCopie = {
    async deposer(d) {
      const cle = `${d.compartiment}/${d.cle}`;
      if (objets.has(cle)) return false;
      objets.set(cle, d);
      return true;
    },
  };
  return { objets, port };
}
const signataire = { async signer(o: Buffer) { return `vault:v1:${createHash("sha256").update(o).digest("base64")}`; } };
function alertes() {
  const envoyees: { type: string; identifiantRupture: string }[] = [];
  return { envoyees, async envoyer(a: { type: "journal_rompu"; identifiantRupture: string }) { envoyees.push(a); } };
}
// Journal imité : deux lignes le 30/10, trois le 31/10 (la veille), une le 01/11 (après minuit : hors de la copie).
function journal(corrompre?: number): LigneJournal[] {
  const jours = ["2026-10-30", "2026-10-30", "2026-10-31", "2026-10-31", "2026-10-31", "2026-11-01"];
  const lignes: LigneJournal[] = [];
  let p: string | null = null;
  jours.forEach((j, i) => {
    const l: LigneJournal = { id: String(i + 1), tenant_id: null, acteur: "agent-essai", action: "insertion", entite: "contacts", entite_id: `c${i}`, ancienne: null, nouvelle: `{"v": ${i}}`, ip: null, cree: `${j}T10:00:00.000000Z`, empreinte_precedente: p, empreinte: "" };
    l.empreinte = empreinteDe(p, l);
    p = l.empreinte;
    lignes.push(l);
  });
  if (corrompre !== undefined) lignes[corrompre] = { ...lignes[corrompre]!, acteur: "forge" };
  return lignes;
}
function lecteurDe(lignes: LigneJournal[]): LecteurJournal {
  return {
    async lireLot(apres, limite) { return lignes.filter((l) => apres === null || BigInt(l.id) > BigInt(apres)).slice(0, limite); },
    async lireIntervalle(debut, fin) { return lignes.filter((l) => l.cree >= debut && l.cree < fin); },
  };
}

describe("copierVeille", () => {
  it("[C-029] la copie de la veille est déposée avec ObjectLock COMPLIANCE et une rétention de 5 ans", async () => {
    const s = stockage();
    const r = await copierVeille({ lecteur: lecteurDe(journal()), port: s.port, signataire, alertes: alertes(), maintenant: () => MAINTENANT });
    expect(r).toMatchObject({ etat: "deposee", cle: "2026-10-31.jsonl", lignes: 3 });
    const d = s.objets.get(`${COMPARTIMENT}/2026-10-31.jsonl`)!;
    expect(COMPARTIMENT).toBe("journal-audit");
    expect(d.modeRetention).toBe("COMPLIANCE");
    const corps = new TextDecoder().decode(d.octets).trimEnd().split("\n").map((x) => JSON.parse(x) as { id: string });
    expect(corps.map((x) => x.id)).toEqual(["3", "4", "5"]);
    const sig = JSON.parse(new TextDecoder().decode(s.objets.get(`${COMPARTIMENT}/2026-10-31.signature.json`)!.octets)) as { jour: string; sha256: string; signature: string };
    expect(sig).toMatchObject({ jour: "2026-10-31", sha256: createHash("sha256").update(d.octets).digest("hex") });
    expect(sig.signature).toMatch(/^vault:v1:/);
  });

  it("[A-182] la rétention écrite sur l'objet est de 5 ans", async () => {
    const s = stockage();
    await copierVeille({ lecteur: lecteurDe([]), port: s.port, signataire, alertes: alertes(), maintenant: () => MAINTENANT });
    for (const d of s.objets.values()) expect(d.retenirJusquA.toISOString()).toBe("2031-11-01T02:30:00.000Z");
    expect(s.objets.size).toBe(2);
  });

  it("[C-029] @anti-doublon deux lancements la même nuit ne déposent qu'une copie", async () => {
    const s = stockage();
    const o = { lecteur: lecteurDe([]), port: s.port, signataire, alertes: alertes(), maintenant: () => MAINTENANT };
    const [a, b] = await Promise.all([copierVeille(o), copierVeille(o)]);
    expect([a.etat, b.etat].sort()).toEqual(["deja_deposee", "deposee"]);
    expect(s.objets.size).toBe(2);
    const file: { id: string }[] = [];
    const fausseFile = { name: "copie", async add(_n: string, _d: unknown, opts?: { jobId?: string }) { file.push({ id: opts!.jobId! }); } };
    await enfilerCopie(fausseFile, MAINTENANT);
    await enfilerCopie(fausseFile, new Date("2026-11-01T23:00:00.000Z"));
    expect(file.map((x) => x.id)).toEqual(["copie-journal-2026-11-01", "copie-journal-2026-11-01"]);
  });

  it("[C-029] une chaîne rompue bloque la copie et envoie l'alerte journal_rompu", async () => {
    const s = stockage();
    const a = alertes();
    const r = await copierVeille({ lecteur: lecteurDe(journal(4)), port: s.port, signataire, alertes: a, maintenant: () => MAINTENANT });
    expect(r.etat).toBe("bloquee");
    expect(s.objets.size).toBe(0);
    expect(a.envoyees).toEqual([{ type: "journal_rompu", identifiantRupture: "5" }]);
  });
});

describe("compartiment journal-audit", () => {
  it("[C-029] initialiser.sh crée le compartiment journal-audit avec le verrouillage d'objets dès la création, sans le recréer ni l'ajouter après coup", () => {
    const t = readFileSync(new URL("../../../../ops/socle/stockage/initialiser.sh", import.meta.url), "utf8");
    expect(t).toMatch(/s3\.bucket\.create -name journal-audit -withLock/);
    // Les quatre compartiments communs gardent leur boucle sans verrou ; journal-audit est vérifié présent comme les autres.
    expect(t).toMatch(/for c in exports factures suivi artefacts; do/);
    expect(t).toMatch(/journal-audit/);
  });
});
