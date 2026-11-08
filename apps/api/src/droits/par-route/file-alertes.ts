import type { Action } from "../matrice.js";

// T5-04c : file d'alertes de l'équipe (routes fermées par défaut). Le rôle « lecteur » est refusé en écriture par la route elle-même.
export default {
  "GET /api/console/v1/alertes": "lire",
  "POST /api/console/v1/alertes/:id/attribuer": "modifier_reglages",
  "POST /api/console/v1/alertes/:id/commenter": "modifier_reglages",
  "POST /api/console/v1/alertes/:id/clore": "modifier_reglages",
  "PUT /api/console/v1/regles-alertes/:id": "modifier_reglages",
} satisfies Readonly<Record<string, Action>>;
