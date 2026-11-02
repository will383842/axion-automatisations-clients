import type { StatutConsole } from "../crm/statuts.ts";

// Statut de la console vers le vocabulaire gelé de C1 (C-324). `en_signature` est interne : il part au Hub comme `prospect`
// et ne devient `client_actif` qu'à contrat_signe. Ce fichier ne déclenche JAMAIS le provisionnement : le seul déclencheur
// est le consommateur de l'événement contrat_signe (C-682, T2-34), pour qu'un passage manuel à `client` ne crée jamais de base sans contrat.
export type StatutHub = "prospect" | "client_actif" | "ancien_client";
const VERS_HUB: Readonly<Record<StatutConsole, StatutHub>> = { prospect: "prospect", en_signature: "prospect", client: "client_actif", ancien_client: "ancien_client" };
export const statutVersHub = (s: StatutConsole): StatutHub => VERS_HUB[s];
