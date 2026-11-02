import type { TxC3 } from "./types.js";

// Une fiche absorbée ne reçoit plus rien : toute cible d'envoi vers le CRM passe par ici et devient la fiche gardée.
export async function cibleDEnvoiCrm(tx: TxC3, crmCompanyId: string): Promise<string> {
  return (await tx.gardeeDe(crmCompanyId)) ?? crmCompanyId;
}
