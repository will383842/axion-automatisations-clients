import type { Action } from "../matrice.js";

export default {
  "GET /api/console/v1/clients/:id/connexions": "lire",
} satisfies Readonly<Record<string, Action>>;
