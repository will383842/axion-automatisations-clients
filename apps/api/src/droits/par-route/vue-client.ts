import type { Action } from "../matrice.js";

export default {
  "GET /api/console/v1/clients/:id/vue-client": "voir_comme_client",
  "POST /api/console/v1/clients/:id/vue-client": "voir_comme_client",
  "POST /api/console/v1/clients/:id/vue-client/demande-accord": "voir_comme_client",
  "POST /api/console/v1/clients/:id/vue-client/fermer": "voir_comme_client",
  "POST /api/console/v1/clients/:id/vue-client/pages": "voir_comme_client",
} satisfies Readonly<Record<string, Action>>;
