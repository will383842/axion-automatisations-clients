import type { Action } from "../matrice.js";

export default {
  "GET /api/console/v1/clients": "lire",
  "GET /api/console/v1/clients/vues": "lire",
  "POST /api/console/v1/clients/vues": "lire",
  "POST /api/console/v1/clients/export": "lire",
} satisfies Readonly<Record<string, Action>>;
