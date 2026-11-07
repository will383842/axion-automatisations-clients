import { domainToASCII } from "node:url";
import { ErreurConnecteur } from "../noyau/politique-erreurs.ts";
import type { Connecteurs } from "../noyau/ports.ts";
import { ArretEnvoisPose, DELAI_LECTURE_MS, gardeIndisponible, lireArret, type ValkeyEnvois } from "./arret-urgence.ts";
import { reserverDepart } from "./delai-annulation.ts";

// Liste fermée : seules ces actions passent par la garde ; lire, étiqueter et créer un brouillon passent telles quelles.
export const ACTIONS_ENVOI: readonly string[] = ["envoyer"];

// Ports de l'isolation (C-534) : implémentations réelles et câblage = dette T4-50e. Port absent = refus de tout envoi.
export interface ProprietaireJeton {
  clientDuJeton(instanceId: string, action: string): Promise<string | undefined>;
}
export interface Carnet {
  connait(tenantId: string, adresse: string): Promise<boolean>;
}

export interface ContexteGarde {
  valkey: ValkeyEnvois;
  // Client de CONFIANCE (configuration servie par la console), jamais celui des données du travail.
  tenantId: string;
  instanceId: string;
  executionId: string;
  annulable: boolean;
  proprietaireJeton?: ProprietaireJeton;
  carnet?: Carnet;
  delaiLectureMs?: number;
}

// Forme canonique : une seule arobase, ni nom affiché ni chevrons ni guillemets ni espace ; domaine en minuscules puis punycode ;
// partie locale en minuscules, « +étiquette » GARDÉ (le retirer rapprocherait deux adresses distinctes).
export function adresseCanonique(brut: unknown): string | undefined {
  if (typeof brut !== "string") return undefined;
  const adresse = brut.trim();
  if (/[\s<>"]/.test(adresse)) return undefined;
  const morceaux = adresse.split("@");
  if (morceaux.length !== 2 || !morceaux[0] || !morceaux[1]) return undefined;
  const domaine = domainToASCII(morceaux[1].toLowerCase());
  return domaine === "" ? undefined : `${morceaux[0].toLowerCase()}@${domaine}`;
}

const refus = (code: string) => new ErreurConnecteur("definitive", code);

// Enveloppe le port Connecteurs d'un travail. Ordre, tout AVANT l'appel : arrêt, port, jeton, destinataire, puis annulation (en dernier : « parti » n'est marqué que si tout le reste a passé).
export function garderConnecteurs(connecteurs: Connecteurs, c: ContexteGarde): Connecteurs {
  return {
    verifier: (action, cle) => connecteurs.verifier(action, cle),
    async appeler(action, demande) {
      if (!ACTIONS_ENVOI.includes(action)) return connecteurs.appeler(action, demande);
      if (await lireArret(c.valkey, c.tenantId, c.delaiLectureMs ?? DELAI_LECTURE_MS)) throw new ArretEnvoisPose();
      if (!c.proprietaireJeton || !c.carnet) throw refus("garde_non_configuree");
      const proprietaire = await c.proprietaireJeton.clientDuJeton(c.instanceId, action).catch(() => { throw gardeIndisponible(); });
      if (proprietaire !== c.tenantId) throw refus("jeton_autre_client");
      const adresse = adresseCanonique((demande.entree as { destinataire?: unknown } | null)?.destinataire);
      if (adresse === undefined) throw refus("destinataire_illisible");
      const connue = await c.carnet.connait(c.tenantId, adresse).catch(() => { throw gardeIndisponible(); });
      if (!connue) throw refus("destinataire_hors_client");
      if (c.annulable) await reserverDepart(c.valkey, c.executionId);
      return connecteurs.appeler(action, demande);
    },
  };
}
