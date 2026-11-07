import type { Action } from "../matrice.js";

export default {
  "GET /api/console/v1/clients/:id/notes": "lire",
  "POST /api/console/v1/clients/:id/notes": "modifier_reglages",
  "POST /api/console/v1/clients/:id/notes/:idNote/epingler": "modifier_reglages",
  "POST /api/console/v1/clients/:id/notes/appel-et-cloture": "modifier_reglages",
} satisfies Readonly<Record<string, Action>>;
