import type { Action } from "../matrice.js";

// Appel signé de Sentry, sans session d'équipe : l'accès est la signature HMAC et la porte fermée par défaut (la garde des droits ne voit que la déclaration).
export default {
  "POST /api/console/v1/sentry/crochet": "lire",
} satisfies Readonly<Record<string, Action>>;
