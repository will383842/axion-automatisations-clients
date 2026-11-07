import type { Action } from "../matrice.js";

export default {
  "POST /api/console/v1/instances/:id/reglages": "modifier_reglages",
  "POST /api/console/v1/instances/:id/reglages/revenir": "modifier_reglages",
  "GET /api/console/v1/instances/:id/reglages/versions": "lire",
} satisfies Readonly<Record<string, Action>>;
