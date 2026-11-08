import { rubriquesLisibles } from "./roles.ts";

// Ce que l'écran montre à un rôle : la même liste que l'API, qui reste seule à refuser.
export const rubriquesVisibles = (role: string): string[] => rubriquesLisibles(role);
