import { MODELE_BASE_CLIENT, type Modele } from "@axion-auto/donnees-module";

// Couche mince (T4-50b) : le modèle des bases clients est celui du paquet @axion-auto/donnees-module (instantané commité, comparé à apps/api/drizzle-cli par modele-paquet.test.ts).
export { analyserModele, type ColonneModele, type Modele, type TableModele } from "@axion-auto/donnees-module";
export const MODELE: Modele = MODELE_BASE_CLIENT;
export const COLONNES_CHIFFREES: ReadonlySet<string> = MODELE.chiffrees;
