import type { Action } from "../matrice.js";

export default {
  "GET /api/console/v1/clients/:id/gel": "lire",
  "POST /api/console/v1/clients/:id/gel": "disjoncteur",
  "POST /api/console/v1/clients/:id/gel/:idGel/lever": "disjoncteur",
} satisfies Readonly<Record<string, Action>>;
