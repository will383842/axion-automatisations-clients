import type { Action } from "../matrice.js";

// T4-28b1 : déploiement d'une instance (routes fermées par défaut). Action provisoire « modifier_reglages » ; une action dédiée reste à décider (dette T4-28b1-dette-matrice-droits).

export default {
  "POST /api/console/v1/clients/:tenantId/instances": "modifier_reglages",
  "POST /api/console/v1/clients/:tenantId/instances/:id/activation": "modifier_reglages",
  "POST /api/console/v1/clients/:tenantId/instances/:id/tests-a-blanc": "modifier_reglages",
} satisfies Readonly<Record<string, Action>>;
