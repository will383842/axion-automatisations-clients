import type { Action } from "../matrice.js";

export default {
  "POST /api/console/v1/a-trancher/:id/appliquer": "modifier_reglages",
  "POST /api/console/v1/a-trancher/:id/ecarter": "modifier_reglages",
} satisfies Readonly<Record<string, Action>>;
