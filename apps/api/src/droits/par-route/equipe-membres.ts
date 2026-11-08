import type { Action } from "../matrice.js";

// T3-07c : membres de l'équipe (dirigeant seul).
export default {
  "GET /api/console/v1/equipe/membres": "utilisateurs_roles",
  "POST /api/console/v1/equipe/membres": "utilisateurs_roles",
  "POST /api/console/v1/equipe/membres/:id/desactiver": "utilisateurs_roles",
} satisfies Readonly<Record<string, Action>>;
