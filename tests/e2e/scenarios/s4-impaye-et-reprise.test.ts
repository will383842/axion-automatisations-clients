import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Scénario 4 : rouge au départ (ADR 0005), il passe au vert au lot indiqué ; retirer alors « .fails ».
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../../packages/contrats/fixtures/${f}.json`, import.meta.url), "utf8")) as unknown;
// Import dynamique à l'intérieur du test : la console n'existe pas encore (un import statique ferait échouer le fichier entier).
const console_ = async () => (await import(/* @vite-ignore */ "../../../apps/console/src/index.js")) as { demarrer: (o: object) => Promise<Record<string, (...a: unknown[]) => Promise<unknown>>> };

test.fails("[C-461] [C-482] impayé : relance, pause proposée après 15 jours, paiement, reprise sans rattrapage @lot-2-bis", async () => {
  // facture en retard, relance proposée
  // 15 jours sans paiement : pause proposée
  // paiement reçu, reprise
  // aucune facture de rattrapage générée
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c2/relance.proposee"), fixture("c2/paiement.recu"), fixture("c1/plans-recurrents")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ pause: "proposee", rattrapage: 0 });
});
