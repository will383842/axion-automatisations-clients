import type { RoleClient } from "./roles.ts";

// Périmètre d'un membre (T6-02b). Le stockage de la liste est T6-16 : sans liste, l'utilisateur ne voit rien (échec fermé).
export interface PerimetreMembre { automatisations: string[]; etablissements: string[] }
export interface PerimetreCalcule { automatisations: string[] | null; etablissements: string[] } // null = toutes les automatisations du client

export function calculerPerimetre(role: RoleClient, etablissementsClient: string[], membre: PerimetreMembre | undefined): PerimetreCalcule {
  if (role !== "utilisateur") return { automatisations: null, etablissements: etablissementsClient };
  if (!membre) return { automatisations: [], etablissements: [] };
  return { automatisations: [...membre.automatisations], etablissements: etablissementsClient.filter((e) => membre.etablissements.includes(e)) };
}
