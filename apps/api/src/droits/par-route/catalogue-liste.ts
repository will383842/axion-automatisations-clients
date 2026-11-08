import type { Action } from "../matrice.js";

// T3-40a : liste, recherche, doublons et synonymes du catalogue (routes fermées par défaut). Les synonymes se modifient par le dirigeant seul.

export default {
  "GET /api/console/v1/catalogue": "lire",
  "GET /api/console/v1/catalogue/recherche": "lire",
  "GET /api/console/v1/catalogue/doublons": "lire",
  "POST /api/console/v1/catalogue/synonymes": "publier_catalogue",
} satisfies Readonly<Record<string, Action>>;
