import type { Action } from "../matrice.js";

// T4-28b2 : mise à jour d'une instance vers une autre version publiée (route fermée par défaut). Même action provisoire que le déploiement (dette T4-28b1-dette-matrice-droits).

export default {
  "POST /api/console/v1/clients/:tenantId/instances/:id/mises-a-jour": "modifier_reglages",
} satisfies Readonly<Record<string, Action>>;
