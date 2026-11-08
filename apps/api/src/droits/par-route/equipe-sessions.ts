import type { Action } from "../matrice.js";

// T3-07b : sécurité de l'équipe (sessions). Dirigeant seul, route globale.
export default {
  "GET /api/console/v1/equipe/sessions": "utilisateurs_roles",
  "POST /api/console/v1/equipe/membres/:id/sessions/:session/revoquer": "utilisateurs_roles",
} satisfies Readonly<Record<string, Action>>;
