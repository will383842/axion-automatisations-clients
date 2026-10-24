import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Scénario 2 : rouge au départ (ADR 0005), il passe au vert au lot indiqué ; retirer alors « .fails ».
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../../packages/contrats/fixtures/${f}.json`, import.meta.url), "utf8")) as unknown;
// Import dynamique à l'intérieur du test : la console n'existe pas encore (un import statique ferait échouer le fichier entier).
const console_ = async () => (await import(/* @vite-ignore */ "../../../apps/console/src/index.js")) as { demarrer: (o: object) => Promise<Record<string, (...a: unknown[]) => Promise<unknown>>> };

test.fails("[C-107] [C-150] abonnement de 6 mois : plan, brouillon, émission, virement, statut @lot-2-bis", async () => {
  // plan récurrent de 6 mois créé
  // brouillon de facture généré
  // émission, puis virement reçu
  // statut « payée » remonté à la console
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/plans-recurrents"), fixture("c1/statuts"), fixture("c2/facture.emise"), fixture("c2/paiement.recu")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ statut: "payee" });
});
