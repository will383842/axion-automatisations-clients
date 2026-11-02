import { empreinteEmail } from "../../../../packages/contrats/src/c3/evenements-crm-vers-console.js";

// Envois commerciaux de la console : liste FERMÉE et nommée. Un retrait de consentement ne coupe que ceux-là.
export const ENVOIS_COMMERCIAUX = ["prospection", "relance_commerciale", "newsletter", "proposition_commerciale"] as const;
// Envois de service : jamais coupés par une exclusion (factures, préavis, avis d'incident).
export const ENVOIS_DE_SERVICE = ["facture", "preavis", "avis_incident"] as const;
export type EnvoiCommercial = (typeof ENVOIS_COMMERCIAUX)[number];
export type EnvoiDeService = (typeof ENVOIS_DE_SERVICE)[number];

export interface Message {
  type: EnvoiCommercial | EnvoiDeService;
  clientId: string;
  destinataire: string;
}
export interface Exclusions {
  estExclue(clientId: string, empreinte: string): Promise<boolean>;
}
export interface Transport {
  envoyer(m: Message): Promise<void>;
}
export type ResultatEnvoi = { envoye: true } | { envoye: false; raison: "exclu" };

// Port des envois : tout envoi commercial passe par ici ; l'empreinte vient de packages/contrats, jamais d'une copie.
export interface EnvoisCommerciaux {
  envoyer(m: Message): Promise<ResultatEnvoi>;
}

export function creerEnvoisCommerciaux(deps: { exclusions: Exclusions; transport: Transport }): EnvoisCommerciaux {
  return {
    async envoyer(m) {
      const commercial = (ENVOIS_COMMERCIAUX as readonly string[]).includes(m.type);
      if (!commercial && !(ENVOIS_DE_SERVICE as readonly string[]).includes(m.type)) throw new Error("type d'envoi inconnu");
      if (commercial && (await deps.exclusions.estExclue(m.clientId, empreinteEmail(m.destinataire)))) return { envoye: false, raison: "exclu" };
      await deps.transport.envoyer(m);
      return { envoye: true };
    },
  };
}
