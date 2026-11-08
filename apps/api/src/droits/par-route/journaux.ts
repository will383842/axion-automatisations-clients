import type { Action } from "../matrice.js";

export default {
  "GET /api/console/v1/journaux": "journal_complet",
} satisfies Readonly<Record<string, Action>>;
