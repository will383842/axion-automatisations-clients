// Rapport pour la CI : identifiants de cas et nombres seulement, jamais le contenu d'un e-mail ni d'une réponse d'IA.
export interface CasRapporte {
  id: string;
  categorie: string;
  reussi: boolean;
  ecart?: string;
}
export interface Rapport {
  module: string;
  version: string;
  cas: CasRapporte[];
  determinisme: { etape: string; reussi: boolean }[];
  hostile: {
    demandes: { refusees: number; brouillons: number; automatiques: number };
    appelsConnecteur: number;
    violations: number;
  };
  totaux: { reussis: number; echoues: number };
  codeSortie: 0 | 1;
}

export function construireRapport(r: Omit<Rapport, "totaux" | "codeSortie">): Rapport {
  const echoues = r.cas.filter((c) => !c.reussi).length + r.determinisme.filter((d) => !d.reussi).length;
  const reussis = r.cas.length + r.determinisme.length - echoues;
  return { ...r, totaux: { reussis, echoues }, codeSortie: echoues > 0 ? 1 : 0 };
}

// JSON stable : clés triées, mêmes octets d'un lancement à l'autre.
export function rapportEnJson(rapport: Rapport): string {
  const trier = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(trier) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, trier(x)])) : v;
  return JSON.stringify(trier(rapport), null, 2);
}
