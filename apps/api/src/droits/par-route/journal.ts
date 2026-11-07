import type { Action } from "../matrice.js";

export default {
  "POST /api/console/v1/journal/:id/annuler": "modifier_reglages",
  "GET /equipe/journal": "journal_complet",
} satisfies Readonly<Record<string, Action>>;
