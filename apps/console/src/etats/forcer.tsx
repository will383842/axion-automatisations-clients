import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Ecran, Etat } from "../ecrans.ts";

// Aides de test (T3-04) : forcent un état d'écran sans variable d'environnement de production.
// Une page qui déclare des états autres que « normal » exporte `etats` : { vide: Composant, … }.
type Page = ComponentType<Record<string, unknown>>;
interface ModulePage {
  default: Page;
  etats?: Partial<Record<Etat, Page>>;
}

const PROPS = { searchParams: Promise.resolve({}), params: Promise.resolve({}) };

async function rendre(Composant: Page): Promise<string> {
  // Composant serveur asynchrone : appelé comme une fonction ; sinon rendu normal.
  if (Composant.constructor.name === "AsyncFunction") return renderToStaticMarkup(await (Composant as unknown as (p: unknown) => Promise<never>)(PROPS));
  return renderToStaticMarkup(createElement(Composant, PROPS));
}

/** HTML de l'écran dans l'état demandé. */
export async function rendreEcran(ecran: Ecran, etat: Etat): Promise<string> {
  const module = (await import(/* @vite-ignore */ new URL(`../app/${ecran.page}`, import.meta.url).href)) as ModulePage;
  if (etat === "normal") return rendre(module.default);
  const forme = module.etats?.[etat];
  if (!forme) throw new Error(`${ecran.route} : l'état « ${etat} » est déclaré mais la page ne l'exporte pas`);
  return rendre(forme);
}
