import type { Action } from "../matrice.js";

// T3-31a1 : grille de prix d'une automatisation (routes fermées par défaut).

export default {
  "GET /api/console/v1/catalogue/automatisations/:id/grille": "lire",
  "GET /api/console/v1/catalogue/automatisations/:id/grille/historique": "lire",
  "POST /api/console/v1/catalogue/automatisations/:id/grille": "publier_catalogue",
} satisfies Readonly<Record<string, Action>>;
