import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { nomBaseDe } from "../../../apps/api/src/provisionnement/etapes-base.ts";
import { basculer, confirmerBascule, type PortsBascule } from "../../../apps/api/src/sauvegardes/basculer.ts";
import type { Restauration } from "../../../apps/api/src/sauvegardes/restaurer-client.ts";

// Critère C-474 : sauvegarde à T0, envoi vers le Hub à T1, restauration de T0 → AUCUN renvoi.
// Simulé : la boîte d'envoi vit dans la base « console » (hors de la base du client), le bouchon du Hub compte les créations.
// Le même scénario sur de vraies bases est une dette de la CI nocturne (voir le compte rendu de T2-40).
test("[C-474] @envoi sauvegarde à T0, envoi à T1, restauration de T0 : aucun renvoi", async () => {
  const tenantId = randomUUID(); const cible = nomBaseDe(tenantId);
  const boite = new Map<string, "envoye">(); // base console
  const creationsHub: string[] = [];          // bouchon du Hub
  const baseClient = { lignes: ["etat-a-T0"] };
  const sauvegardeT0 = structuredClone(baseClient);
  // T1 : envoi
  creationsHub.push("demande-1"); boite.set("demande-1", "envoye"); baseClient.lignes.push("effet-externe:demande-1");
  // restauration de T0 puis bascule
  const r: Restauration = { id: randomUUID(), tenantId, nomBase: `${cible}_restau_1`, numero: 1, source: { depuis: "dump", date: "2026-11-01" }, etat: "prete" };
  const confirmations: { acteurId: string; reauthJeton: string }[] = []; let basculee = false;
  const ports: PortsBascule = {
    lire: async () => ({ ...r, confirmations: [...confirmations], basculee }),
    ajouterConfirmation: async (_t, _i, c) => { confirmations.push(c); },
    marquerBasculee: async () => { basculee = true; Object.assign(baseClient, sauvegardeT0); },
    pauser: async () => {}, ouvrirAuxRoles: async () => {}, reprendre: async () => {}, renommer: async () => {}, journaliser: async () => {},
  };
  await confirmerBascule(ports, tenantId, r.id, { id: "u1", equipe: true, reauthJeton: randomUUID() });
  await confirmerBascule(ports, tenantId, r.id, { id: "u2", equipe: true, reauthJeton: randomUUID() });
  await expect(basculer(ports, tenantId, r.id)).rejects.toThrow("deja_basculee");
  expect(baseClient.lignes).toEqual(["etat-a-T0"]); // la base est bien revenue à T0
  expect(creationsHub).toEqual(["demande-1"]);       // aucune nouvelle création chez le bouchon
  expect([...boite.values()]).toEqual(["envoye"]);   // la ligne reste « envoye »
});
