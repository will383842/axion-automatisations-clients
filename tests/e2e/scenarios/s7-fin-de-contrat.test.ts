import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Scénario 7 : rouge au départ (ADR 0005), il passe au vert au lot indiqué ; retirer alors « .fails ».
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../../packages/contrats/fixtures/${f}.json`, import.meta.url), "utf8")) as unknown;
// Import dynamique à l'intérieur du test : la console n'existe pas encore (un import statique ferait échouer le fichier entier).
const console_ = async () => (await import(/* @vite-ignore */ "../../../apps/console/src/index.js")) as { demarrer: (o: object) => Promise<Record<string, (...a: unknown[]) => Promise<unknown>>> };

test.fails("[C-459] [C-475] fin de contrat : plans clos, export, préavis, destruction, attestations, CRM « perdu » @lot-2b", async () => {
  // plans du Hub clos d'abord
  // export des données du client
  // préavis puis destruction
  // attestations émises, CRM « perdu »
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/plans-recurrents-clore"), fixture("c1/clients-statut")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ plansClos: true, attestations: 1, statutCrm: "perdu" });
});
