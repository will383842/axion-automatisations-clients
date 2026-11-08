import type { Action } from "../matrice.js";

export default {
  "GET /api/console/v1/clients/:id/plan": "lire",
} satisfies Readonly<Record<string, Action>>;
