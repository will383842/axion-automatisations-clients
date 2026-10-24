import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Scénario 5 : rouge au départ (ADR 0005), il passe au vert au lot indiqué ; retirer alors « .fails ».
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../../packages/contrats/fixtures/${f}.json`, import.meta.url), "utf8")) as unknown;
// Import dynamique à l'intérieur du test : la console n'existe pas encore (un import statique ferait échouer le fichier entier).
const console_ = async () => (await import(/* @vite-ignore */ "../../../apps/console/src/index.js")) as { demarrer: (o: object) => Promise<Record<string, (...a: unknown[]) => Promise<unknown>>> };

test.fails("[C-455] [C-457] doublon de SIREN détecté, fusion répercutée @lot-2-ter", async () => {
  // deux fiches avec le même SIREN
  // fusion côté CRM
  // identifiant mis à jour dans la console
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c2/fiche.fusionnee")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ doublons: 0 });
});

test.fails("[C-456] particulier sans SIREN : proposé, jamais fusionné seul @lot-2-ter", async () => {
  // particulier sans SIREN ressemblant à une fiche
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/clients-retrouver-ou-creer")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ fusionsAutomatiques: 0 });
});

test.fails("[C-540] contrôle de nuit des doublons @lot-2-ter", async () => {
  // lancement du contrôle de nuit
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c2/fiche.fusionnee"), fixture("c2/fiche.fusion_annulee")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ anomalies: 0 });
});
