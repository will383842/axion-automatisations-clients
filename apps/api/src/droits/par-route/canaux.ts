import type { Action } from "../matrice.js";

export default {
  "GET /api/console/v1/canaux/echecs": "lire",
  "POST /api/console/v1/canaux/echecs/:tenantId/:id/renvoyer": "relancer",
} satisfies Readonly<Record<string, Action>>;
