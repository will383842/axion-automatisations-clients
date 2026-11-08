import type { Action } from "../matrice.js";

// T3-31a2 : liste du catalogue de l'équipe (route fermée par défaut).

export default {
  "GET /api/console/v1/catalogue": "lire",
} satisfies Readonly<Record<string, Action>>;
