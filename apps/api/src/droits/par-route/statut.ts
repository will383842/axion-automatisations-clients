import type { Action } from "../matrice.js";

// T5-12b : gestion de la page d'état (dirigeant seul, droit page_etat). La page publique et la sonde sont hors console : signal signé pour la sonde, aucun droit de console.
export default {
  "GET /api/console/v1/statut": "page_etat",
  "PUT /api/console/v1/statut": "page_etat",
} satisfies Readonly<Record<string, Action>>;
