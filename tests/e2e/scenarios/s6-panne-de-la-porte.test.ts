import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Scénario 6 : rouge au départ (ADR 0005), il passe au vert au lot indiqué ; retirer alors « .fails ».
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../../packages/contrats/fixtures/${f}.json`, import.meta.url), "utf8")) as unknown;
// Import dynamique à l'intérieur du test : la console n'existe pas encore (un import statique ferait échouer le fichier entier).
const console_ = async () => (await import(/* @vite-ignore */ "../../../apps/console/src/index.js")) as { demarrer: (o: object) => Promise<Record<string, (...a: unknown[]) => Promise<unknown>>> };

test.fails("[C-483] [C-535] Hub ou CRM arrêtés : file, reprise sans perte ni double envoi, même Idempotency-Key @lot-2", async () => {
  // Hub et CRM arrêtés, 3 demandes mises en file
  // reprise des simulateurs
  // chaque demande rejouée avec la même Idempotency-Key
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/clients-retrouver-ou-creer"), fixture("c1/devis"), fixture("c1/plans-recurrents")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ perdues: 0, doublons: 0, clesIdentiques: true });
});
