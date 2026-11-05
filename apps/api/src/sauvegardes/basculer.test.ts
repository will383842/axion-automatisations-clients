import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nomBaseDe } from "../provisionnement/etapes-base.js";
import { basculer, confirmerBascule, type Acteur, type PortsBascule } from "./basculer.js";
import type { Restauration } from "./restaurer-client.js";

function montage() {
  const tenantId = randomUUID(); const cible = nomBaseDe(tenantId);
  const r: Restauration = { id: randomUUID(), tenantId, nomBase: `${cible}_restau_2`, numero: 2, source: { depuis: "dump", date: "2026-11-01" }, etat: "prete" };
  const j = { ordre: [] as string[], renommages: [] as [string, string][], journal: [] as string[], confirmations: [] as { acteurId: string; reauthJeton: string }[], basculee: false, destructions: 0 };
  const p: PortsBascule = {
    async lire(t, id) { return t === tenantId && id === r.id ? { ...r, confirmations: [...j.confirmations], basculee: j.basculee } : undefined; },
    async ajouterConfirmation(_t, _id, c) { j.confirmations.push(c); },
    async marquerBasculee() { j.basculee = true; },
    async pauser(n) { j.ordre.push(`pause:${n}`); },
    async reprendre(n) { j.ordre.push(`reprise:${n}`); },
    async renommer(de, vers) { j.ordre.push(`rename:${de}>${vers}`); j.renommages.push([de, vers]); },
    async journaliser(e) { j.journal.push(e); },
  };
  const acteur = (id = "u1", reauthJeton = randomUUID()): Acteur => ({ id, equipe: true, reauthJeton });
  return { tenantId, cible, r, j, p, acteur };
}

describe("basculer", () => {
  it("[B-041] la bascule exige une double confirmation", async () => {
    const { p, tenantId, r, j, acteur } = montage();
    expect(await confirmerBascule(p, tenantId, r.id, acteur("u1"))).toEqual({ confirmations: 1, basculee: false });
    expect(j.renommages).toHaveLength(0);
    await expect(basculer(p, tenantId, r.id)).rejects.toThrow("confirmation_manquante");
    expect(await confirmerBascule(p, tenantId, r.id, acteur("u1"))).toEqual({ confirmations: 2, basculee: true });
    expect(j.renommages).toHaveLength(2);
  });
  it("[B-041] deux confirmations de la même personne sans nouvelle réauthentification ne suffisent pas", async () => {
    const { p, tenantId, r, j } = montage(); const jeton = randomUUID();
    await confirmerBascule(p, tenantId, r.id, { id: "u1", equipe: true, reauthJeton: jeton });
    await expect(confirmerBascule(p, tenantId, r.id, { id: "u1", equipe: true, reauthJeton: jeton })).rejects.toThrow("reauthentification_requise");
    expect(j.renommages).toHaveLength(0);
  });
  it("[B-041] deux personnes différentes suffisent", async () => {
    const { p, tenantId, r, acteur } = montage();
    await confirmerBascule(p, tenantId, r.id, acteur("u1"));
    expect((await confirmerBascule(p, tenantId, r.id, acteur("u2"))).basculee).toBe(true);
  });
  it("[B-041] un utilisateur de client ne confirme pas", async () => {
    const { p, tenantId, r, j } = montage();
    await expect(confirmerBascule(p, tenantId, r.id, { id: "c1", equipe: false, reauthJeton: randomUUID() })).rejects.toThrow("action_interdite");
    expect(j.confirmations).toHaveLength(0);
  });
  it("[C-536] @isolation la restauration d'un autre client est introuvable", async () => {
    const { p, r, j, acteur } = montage();
    await expect(confirmerBascule(p, randomUUID(), r.id, acteur())).rejects.toThrow("restauration_introuvable");
    expect(j.confirmations).toHaveLength(0);
  });
  it("[C-048] l'ancienne base est gardée sous un autre nom après bascule", async () => {
    const { p, tenantId, r, j, cible, acteur } = montage();
    await confirmerBascule(p, tenantId, r.id, acteur("u1")); await confirmerBascule(p, tenantId, r.id, acteur("u2"));
    expect(j.ordre).toEqual([`pause:${cible}`, `rename:${cible}>${cible}_avant_2`, `rename:${cible}_restau_2>${cible}`, `reprise:${cible}`]);
    expect(j.journal).toContain("bascule_faite");
    expect(j.basculee).toBe(true);
  });
  it("[C-048] une restauration déjà basculée ne bascule pas deux fois", async () => {
    const { p, tenantId, r, j, acteur } = montage();
    await confirmerBascule(p, tenantId, r.id, acteur("u1")); await confirmerBascule(p, tenantId, r.id, acteur("u2"));
    await expect(basculer(p, tenantId, r.id)).rejects.toThrow("deja_basculee");
    expect(j.renommages).toHaveLength(2);
  });
  it("[C-048] si le second renommage échoue, l'ancienne base reprend son nom et PgBouncer reprend", async () => {
    const { p, tenantId, r, j, cible, acteur } = montage();
    const ren = p.renommer; let n = 0; p.renommer = async (de, vers) => { if (++n === 2) throw new Error("renommage_echoue"); return ren(de, vers); };
    await confirmerBascule(p, tenantId, r.id, acteur("u1"));
    await expect(confirmerBascule(p, tenantId, r.id, acteur("u2"))).rejects.toThrow("renommage_echoue");
    expect(j.renommages).toEqual([[cible, `${cible}_avant_2`], [`${cible}_avant_2`, cible]]);
    expect(j.ordre.at(-1)).toBe(`reprise:${cible}`);
    expect(j.basculee).toBe(false);
  });
});
