import type { Action } from "../matrice.js";

// T5-04c : file d'alertes de l'équipe (routes fermées par défaut). Chaque route pose exigerDroit : la portée du second administrateur est vérifiée (hors portée = 404).
export default {
  "GET /api/console/v1/alertes": "lire",
  "POST /api/console/v1/alertes/:id/attribuer": "modifier_reglages",
  "POST /api/console/v1/alertes/:id/commenter": "modifier_reglages",
  "POST /api/console/v1/alertes/:id/clore": "modifier_reglages",
  "PUT /api/console/v1/regles-alertes/:id": "modifier_reglages",
} satisfies Readonly<Record<string, Action>>;
