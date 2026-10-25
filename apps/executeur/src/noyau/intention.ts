import { createHash } from "node:crypto";
import type { Connecteur } from "@axion-auto/sdk-module";
import { ErreurConnecteur } from "./politique-erreurs.ts";
import type { Ports } from "./ports.ts";

// Stopper sans renvoyer : l'effet est peut-être parti, un humain tranche.
export class ATrancher extends Error {}

// Clé anti-doublon : UUID v5 de (instance, exécution, étape, élément). Le tableau JSON évite toute ambiguïté de séparateur.
const ESPACE = Buffer.from("b1c4a2f0-5d3e-4f6a-9c1b-7e2d8a4f6b30".replaceAll("-", ""), "hex");
export function deriverCle(instanceId: string, executionId: string, etape: string, element: string): string {
  const h = createHash("sha1").update(ESPACE).update(JSON.stringify([instanceId, executionId, etape, element])).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export interface BaseEffet {
  instanceId: string;
  executionId: string;
  etape: string;
  connecteurs: readonly Connecteur[];
}

// Rend vrai si l'effet est acquis maintenant (compté comme élément). Une intention est écrite AVANT tout appel ; la garantie du connecteur décide de la suite après une coupure.
export async function effet(ports: Ports, base: BaseEffet, action: string, element: string, entree: unknown): Promise<boolean> {
  const decl = base.connecteurs.find((c) => c.actions.includes(action));
  if (!decl) throw new ErreurConnecteur("definitive", "action_non_declaree");
  const cle = deriverCle(base.instanceId, base.executionId, base.etape, element);
  const { boite, connecteurs } = ports;
  const { intention, creee } = await boite.ecrire({ cle, instanceId: base.instanceId, executionId: base.executionId, etape: base.etape, element, action, garantie: decl.garantie });
  if (intention.etat === "faite") return false;
  if (intention.etat === "a_trancher") throw new ATrancher();
  if (!creee) {
    if (decl.garantie === "au_plus_une_fois") return aTrancher(ports, cle);
    if (decl.garantie === "verifiable_apres_coup") {
      const v = await connecteurs.verifier(action, cle);
      if (v === "inconnue") return aTrancher(ports, cle);
      if (v === "trouvee") {
        await boite.marquerFaite(cle);
        return true;
      }
    }
  }
  await connecteurs.appeler(action, { cle, element, entree });
  await boite.marquerFaite(cle);
  return true;
}

async function aTrancher(ports: Ports, cle: string): Promise<never> {
  await ports.boite.marquerATrancher(cle);
  throw new ATrancher();
}
