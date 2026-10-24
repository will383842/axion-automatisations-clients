import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Scénario 8 : rouge au départ (ADR 0005), il passe au vert au lot indiqué ; retirer alors « .fails ».
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../../packages/contrats/fixtures/${f}.json`, import.meta.url), "utf8")) as unknown;
// Import dynamique à l'intérieur du test : la console n'existe pas encore (un import statique ferait échouer le fichier entier).
const console_ = async () => (await import(/* @vite-ignore */ "../../../apps/console/src/index.js")) as { demarrer: (o: object) => Promise<Record<string, (...a: unknown[]) => Promise<unknown>>> };

test.fails("[C-260] [C-470] coupure après l'envoi, avant le journal (mode reponse_perdue du faux Graph) : au plus un message dans Mailpit @lot-4", async () => {
  // faux Graph en mode reponse_perdue
  // recherche dans Éléments envoyés
  // au plus un message dans Mailpit
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/faits")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ messagesMailpit: 1 });
});

test.fails("[C-260] sans conclusion de la recherche : « à trancher », aucun renvoi @lot-4", async () => {
  // recherche sans conclusion
  // état « à trancher »
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/faits")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ etat: "a_trancher", renvois: 0 });
});

test.fails("[C-576] « Annuler » possible pendant 10 secondes @lot-4", async () => {
  // envoi demandé
  // annulation à 9 s
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/faits")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ envoye: false });
});

test.fails("[C-534] arrêt d'urgence effectif en moins de 60 secondes @lot-4", async () => {
  // arrêt d'urgence déclenché
  const app = await (await console_()).demarrer({ simulateurs: true });
  const entrees = [fixture("c1/faits")];
  const resultat = await app.rejouer!(entrees);
  expect(resultat).toEqual({ envoisApres60s: 0 });
});
