import type { DependancesTransit } from "./deposer.ts";
import { DUREE_TRANSIT_MS } from "./expirer.ts";
import { contexteTransit, ErreurTransit, lireObjet, lireReference } from "./port.ts";

// Lecture d'une copie de transit (C-023) : refus d'une référence d'un autre client AVANT tout appel au stockage ;
// refus d'une copie de plus de 24 h même si la règle du compartiment et le balayage n'ont rien effacé ; déchiffrement en mémoire seulement.
export async function lire(d: DependancesTransit, reference: string, tenantId: string): Promise<Buffer> {
  const cle = lireReference(reference, tenantId);
  let objet;
  try {
    objet = await d.port.lire(cle);
  } catch {
    throw new ErreurTransit("transit_indisponible");
  }
  if (!objet) throw new ErreurTransit("transit_absent");
  if (d.horloge.maintenant() - objet.ecritLe >= DUREE_TRANSIT_MS) throw new ErreurTransit("transit_expire");
  try {
    return await d.chiffreur.dechiffrer(tenantId, lireObjet(objet.octets), contexteTransit(cle));
  } catch {
    throw new ErreurTransit("transit_illisible");
  }
}
