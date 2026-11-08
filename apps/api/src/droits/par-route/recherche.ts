import type { Action } from "../matrice.js";

export default {
  "GET /api/console/v1/recherche": "lire",
} satisfies Readonly<Record<string, Action>>;
