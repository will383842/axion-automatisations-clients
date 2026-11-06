import { randomBytes } from "node:crypto";
import { contexteTransit, ErreurTransit, serialiser, validerClient, type Chiffreur, type Horloge, type PortTransit } from "./port.ts";

export interface DependancesTransit {
  port: PortTransit;
  chiffreur: Chiffreur;
  horloge: Horloge;
}

// Copie de transit d'une pièce jointe (A-371) : chiffrée par la clé du client, rangée sous un nom aléatoire préfixé par le client.
// Renvoie une référence opaque, jamais une adresse. L'original reste dans la boîte du client ; aucune autre copie n'est faite.
export async function deposer(d: DependancesTransit, tenantId: string, octets: Buffer): Promise<string> {
  const cle = `${validerClient(tenantId)}/${randomBytes(32).toString("hex")}`;
  try {
    await d.port.ecrire(cle, serialiser(await d.chiffreur.chiffrer(tenantId, octets, contexteTransit(cle))));
  } catch {
    // Le message d'origine peut contenir le contenu : il n'est pas relayé.
    throw new ErreurTransit("transit_indisponible");
  }
  return cle;
}
