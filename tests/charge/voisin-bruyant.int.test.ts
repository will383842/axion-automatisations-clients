import { writeSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Palier } from "../../apps/executeur/src/config.ts";
import { Repartiteur, SousFilesMemoire } from "../../apps/executeur/src/files/tour-de-role.ts";

// Test de charge du voisin bruyant (A-414) : 300 clients fictifs, 20 instances chacun, un client « bruyant » met 10 000 travaux en file.
// Mesure en TOURS de répartiteur (un travail sort à chaque tirage), donc indépendante de la machine. Le seuil est [À DÉFINIR] au lot 8a :
// la valeur mesurée est écrite dans la sortie d'erreur du test et reprise dans la description de la PR.
const POIDS: Record<Palier, number> = { essentiel: 1, pro: 2, etendu: 4 };
const PALIERS: Palier[] = ["essentiel", "pro", "etendu"];

describe("voisin bruyant", () => {
  it("[A-414] un client avec 10 000 travaux en file ne retarde pas un autre client au-delà du seuil de test", async () => {
    const r = new Repartiteur(new SousFilesMemoire(), POIDS);
    const clients = Array.from({ length: 300 }, (_, i) => ({ id: `client-${i}`, palier: PALIERS[i % 3]! }));
    const bruyant = clients[0]!;
    for (let i = 0; i < 10_000; i++) await r.ajouter({ id: `b-${i}`, instanceId: `inst-${bruyant.id}-${i % 20}`, clientId: bruyant.id, palier: "etendu" });
    for (const c of clients.slice(1)) for (let i = 0; i < 20; i++) await r.ajouter({ id: `${c.id}-${i}`, instanceId: `inst-${c.id}-${i}`, clientId: c.id, palier: c.palier });

    // rang de sortie du dernier travail de chaque client calme (son retard, en tirages)
    const dernier = new Map<string, number>();
    let rang = 0;
    for (let t = await r.suivant(); t; t = await r.suivant()) dernier.set(t.clientId, ++rang);
    const tourComplet = clients.reduce((s, c) => s + (c.id === bruyant.id ? POIDS.etendu : POIDS[c.palier]), 0);
    const calmes = clients.slice(1).map((c) => dernier.get(c.id)!);
    const pire = Math.max(...calmes);
    // sans tour de rôle, le dernier calme sortirait après les 10 000 travaux du bruyant (rang > 10 000)
    const travauxCalmes = 299 * 20;
    writeSync(2, `charge: pire fin d'un client calme au tirage ${pire} sur ${rang} ; tour complet = ${tourComplet} tirages ; ${travauxCalmes} travaux calmes\n`);
    expect(pire).toBeLessThan(10_000);
    // chaque client calme a fini avant que le bruyant n'ait passé plus de ses tours : le retard est borné par le nombre de tours (20) × le tour complet
    expect(pire).toBeLessThanOrEqual(20 * tourComplet);
  }, 120_000);
});
