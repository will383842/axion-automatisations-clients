// Table FERMÉE « type d'information → système maître » (C-362, C-343, C-095). Toute comparaison de nuit s'y réfère : un seul maître par information.
export type Systeme = "console" | "crm" | "hub";

export const MAITRES = Object.freeze({
  statut_client: "console",
  prospect: "crm",
  echanges: "crm",
  devis: "hub",
  factures: "hub",
  paiements: "hub",
  automatisations: "console",
  executions: "console",
  demandes: "console",
  formule: "console",
  plan_commercial: "console",
  renouvellements: "console",
  visibilite: "console",
  acces: "console",
} as const satisfies Record<string, Systeme>);

export type TypeInformation = keyof typeof MAITRES;

export function maitreDe(type: TypeInformation): Systeme {
  if (!Object.hasOwn(MAITRES, type)) throw new Error(`type d'information inconnu : ${String(type)}`);
  return MAITRES[type];
}
