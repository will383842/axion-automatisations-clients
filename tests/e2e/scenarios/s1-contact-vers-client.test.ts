import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Scénario 1 : rouge au départ (ADR 0005), il passe au vert au lot indiqué ; retirer alors « .fails ».
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../../packages/contrats/fixtures/${f}.json`, import.meta.url), "utf8")) as unknown;
// Import dynamique à l'intérieur du test : la console n'existe pas encore (un import statique ferait échouer le fichier entier).
const console_ = async () => (await import(/* @vite-ignore */ "../../../apps/console/src/index.js")) as { demarrer: (o: object) => Promise<Record<string, (...a: unknown[]) => Promise<unknown>>> };

test.fails("[C-456] [C-481] parcours nominal : un contact devient un client @lot-2", async () => {
  // Hub : fiche avec SIREN reçue
  // la console propose la création, un clic la confirme
  // le client existe, rattaché au Hub et au CRM
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/clients-retrouver-ou-creer")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ clients: 1, propositions: 0 });
});

test.fails("[C-456] [C-550] variante négative : fiche Hub sans SIREN, rien créé seul @lot-2", async () => {
  // fiche Hub sans SIREN
  // la console la range dans « à rapprocher »
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/clients-retrouver-ou-creer")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ clients: 0, propositions: 1 });
});

test.fails("[C-456] [C-550] variante négative : client du CRM ressaisi à la main, rien créé seul @lot-2", async () => {
  // client déjà connu du CRM, saisi à la main
  // la console propose le rattachement
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/clients-retrouver-ou-creer")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ clients: 0, propositions: 1 });
});

test.fails("[C-456] [C-550] variante négative : particulier dont l'e-mail a changé, rien créé seul @lot-2", async () => {
  // particulier connu, e-mail modifié
  // la console propose le rattachement, ne crée rien
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/clients-retrouver-ou-creer")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ clients: 0, propositions: 1 });
});
