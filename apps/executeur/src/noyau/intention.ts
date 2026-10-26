import { createHash, randomUUID } from "node:crypto";
import type { Connecteur } from "@axion-auto/sdk-module";
import { ErreurConnecteur } from "./politique-erreurs.ts";
import { CoupureProcessus, type Ports } from "./ports.ts";

// Stopper sans renvoyer : l'effet est peut-être parti, un humain tranche.
export class ATrancher extends Error {}

// Un autre lancement tient le bail : ce n'est pas une erreur de l'outil, rien n'est inscrit ni envoyé.
export class IntentionEnCours extends Error {}

// Marge après la fin de l'étape : l'appel en vol doit finir dans ce délai après l'arrêt (manque 20).
export const DELAI_GRACE_MS = 60_000;

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
  // Liste du client (C-539) : « brouillon » ne part jamais en automatique.
  classer(action: string): "automatique" | "brouillon";
  signal: AbortSignal;
  // Instant où l'étape est coupée : le bail court jusque-là plus la marge.
  finEtape: number;
}

const coupee = () => new ErreurConnecteur("passagere", "delai_depasse");

// Rend vrai si l'effet est acquis maintenant (compté comme élément). Une intention est écrite AVANT tout appel, sous un bail ; la garantie du connecteur décide de la suite après une coupure.
export async function effet(ports: Ports, base: BaseEffet, action: string, element: string, entree: unknown): Promise<boolean> {
  if (base.signal.aborted) throw coupee();
  const decl = base.connecteurs.find((c) => c.actions.includes(action));
  if (!decl) throw new ErreurConnecteur("definitive", "action_non_declaree");
  if (base.classer(action) === "brouillon") throw new ErreurConnecteur("definitive", "action_non_autorisee");
  const cle = deriverCle(base.instanceId, base.executionId, base.etape, element);
  const { boite, connecteurs, horloge } = ports;
  const proprietaire = randomUUID();
  const bail = { proprietaire, jusqua: base.finEtape + DELAI_GRACE_MS };
  const { intention, creee, occupee } = await boite.ecrire({ cle, instanceId: base.instanceId, executionId: base.executionId, etape: base.etape, element, action, garantie: decl.garantie }, bail, horloge.maintenant());
  if (intention.action !== action) throw new ErreurConnecteur("definitive", "cle_en_conflit");
  if (intention.etat === "faite") return false;
  if (intention.etat === "a_trancher") throw new ATrancher();
  if (occupee) throw new IntentionEnCours();
  try {
    if (!creee) {
      if (decl.garantie === "au_plus_une_fois") return await aTrancher(ports, cle, proprietaire);
      if (decl.garantie === "verifiable_apres_coup") {
        const v = await connecteurs.verifier(action, cle);
        if (v === "inconnue") return await aTrancher(ports, cle, proprietaire);
        if (v === "trouvee") {
          if (!(await boite.marquerFaite(cle, proprietaire))) throw new ATrancher();
          return true;
        }
      }
    }
    if (base.signal.aborted) throw coupee();
    await connecteurs.appeler(action, { cle, element, entree, signal: base.signal });
  } catch (e) {
    // Une coupure, ou un signal annulé (la requête a pu partir), laisse le bail jusqu'à son échéance ; tout autre arrêt est connu, le bail est rendu.
    if (!(e instanceof CoupureProcessus) && !(e instanceof ATrancher) && !base.signal.aborted) await boite.liberer(cle, proprietaire);
    throw e;
  }
  if (!(await boite.marquerFaite(cle, proprietaire))) throw new ATrancher();
  return true;
}

async function aTrancher(ports: Ports, cle: string, proprietaire: string): Promise<never> {
  await ports.boite.marquerATrancher(cle, proprietaire);
  throw new ATrancher();
}
