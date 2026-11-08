import { ENVOIS_COMMERCIAUX } from "./exclusions.js";

// Port des e-mails de SERVICE de la console (jamais commerciaux : aucune exclusion ne les coupe). L'envoi réel est branché au lot 3 ou 6 ;
// le texte vient du catalogue (modèle T2-00), ici seulement le type, le client et une clé anti-doublon qui inclut le client.
export const TYPES_SERVICE = ["avis_gel_pose", "avis_gel_leve", "avis_vue_client_ouverte", "demande_accord_vue_client"] as const;
export type TypeService = (typeof TYPES_SERVICE)[number];
export interface MessageService {
  type: TypeService;
  clientId: string;
  // `${type}:${clientId}:${objet}` : le même dépôt rejoué ne crée rien de plus.
  cle: string;
  categorie: "service";
}
export interface EnvoisService {
  deposerService(m: MessageService): Promise<void>;
}

export function envoisServiceEnMemoire(): EnvoisService & { deposes: MessageService[] } {
  const deposes: MessageService[] = [];
  return {
    deposes,
    async deposerService(m) {
      if (!(TYPES_SERVICE as readonly string[]).includes(m.type) || (ENVOIS_COMMERCIAUX as readonly string[]).includes(m.type)) throw new Error("type d'e-mail de service inconnu");
      if (!deposes.some((d) => d.cle === m.cle)) deposes.push({ type: m.type, clientId: m.clientId, cle: m.cle, categorie: "service" });
    },
  };
}
