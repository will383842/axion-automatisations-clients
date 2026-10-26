// Plafonds de dépense d'IA (C-437, C-598). Valeurs [À DÉFINIR] au lot 8a : AUCUNE valeur par défaut, l'API refuse de démarrer sans elles.
// Les messages citent les noms des variables, jamais leurs valeurs.

export class ConfigPlafondsInvalide extends Error {}

export interface Plafonds {
  cleClientMicroCentimes: number;
  passerelleJourMicroCentimes: number;
  seuilRythmeAnormal: number;
}

// Texte canonique seulement : « 1e3 », « 0x10 », « 007 », un espace, un signe ou une virgule ne passent pas.
const canonique = (v: string | undefined): number | undefined => {
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return v === String(n) ? n : undefined;
};
const entierPositif = (v: string | undefined) => {
  const n = canonique(v);
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};
const rapport = (v: string | undefined) => {
  const n = canonique(v);
  return n !== undefined && Number.isFinite(n) && n > 1 ? n : undefined;
};

export function chargerPlafonds(env: NodeJS.ProcessEnv): Plafonds {
  const cle = entierPositif(env["PLAFOND_CLE_CLIENT_MICROCENTIMES"]);
  const jour = entierPositif(env["PLAFOND_PASSERELLE_JOUR_MICROCENTIMES"]);
  const seuil = rapport(env["SEUIL_RYTHME_ANORMAL"]);
  const manquants = [
    cle === undefined && "PLAFOND_CLE_CLIENT_MICROCENTIMES",
    jour === undefined && "PLAFOND_PASSERELLE_JOUR_MICROCENTIMES",
    seuil === undefined && "SEUIL_RYTHME_ANORMAL",
  ].filter(Boolean);
  if (manquants.length || cle === undefined || jour === undefined || seuil === undefined) {
    throw new ConfigPlafondsInvalide(`plafonds absents ou invalides : ${manquants.join(", ")}`);
  }
  return { cleClientMicroCentimes: cle, passerelleJourMicroCentimes: jour, seuilRythmeAnormal: seuil };
}
