import type { Action } from "../matrice.js";

export default {
  "POST /api/console/v1/clients/:id/connexions/liens": "connexions_secrets",
  "POST /api/console/v1/clients/:id/connexions/:connexionId/revoquer": "connexions_secrets",
} satisfies Readonly<Record<string, Action>>;
