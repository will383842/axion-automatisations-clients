declare module "js-yaml" {
  interface EtatAnalyse {
    anchor?: string | null;
  }
  interface OptionsAnalyse {
    listener?: (evenement: "open" | "close", etat: EtatAnalyse) => void;
  }
  export function loadAll(texte: string, iterateur: null, options?: OptionsAnalyse): unknown[];
}
