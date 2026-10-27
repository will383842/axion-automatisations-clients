// Journal des échanges entre systèmes (C-344) : une ligne par passage, jamais le corps ni la signature.
// Les champs sont écrits un par un : rien d'autre ne peut sortir.
export type Canal = "c1" | "c2" | "c3";
export interface Journal {
  info(ligne: object, message?: string): void;
}
export interface EntreeCanal {
  canal: Canal;
  sens: "entrant" | "sortant";
  route: string;
  cle: string | undefined;
  horodatage: string | undefined;
  resultat: string;
  id_trace: string;
}

// La requête (après « ? ») peut porter des jetons : seul le chemin est gardé.
const cheminSeul = (route: string) => route.split("?")[0] ?? "";
// Un en-tête reçu n'est repris que s'il a la forme attendue : aucune ligne forgée dans le journal.
const nettoyer = (v: string | undefined, forme: RegExp) => (v !== undefined && forme.test(v) ? v : undefined);

export function journaliser(journal: Journal | undefined, e: EntreeCanal): void {
  journal?.info(
    {
      canal: e.canal,
      sens: e.sens,
      route: cheminSeul(e.route).replace(/[^\x21-\x7e]/g, "?").slice(0, 200),
      cle: nettoyer(e.cle, /^[a-z0-9-]{1,64}$/),
      horodatage: nettoyer(e.horodatage, /^[0-9]{10}$/),
      resultat: e.resultat,
      id_trace: e.id_trace,
    },
    "canal",
  );
}
