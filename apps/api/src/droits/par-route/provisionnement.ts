import type { Action } from "../matrice.js";

export default {
  "POST /api/console/v1/clients/:id/base/reprendre": "relancer",
} satisfies Readonly<Record<string, Action>>;
