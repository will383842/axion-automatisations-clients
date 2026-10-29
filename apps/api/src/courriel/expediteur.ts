import { createHash } from "node:crypto";
import type { Destinataire, Envoi } from "../../../../packages/contrats/src/notifications/table.js";
import { rendre } from "./gabarits.js";

// Un seul chemin pour tout e-mail de service (A-116) : clé présente dans la table des envois, interrupteur ouvert, gabarit à liste blanche, trace.
// Aucun repli : si une étape manque, rien ne part. Le transport est Mailpit en CI, ZeptoMail en production.

export interface Message { de?: string; a: string; sujet: string; texte: string }
export interface Transport { envoyer(m: Message): Promise<void> }
export interface Interrupteurs { ouvert(nom: string): boolean }
export interface Trace { cle: string; destinataireHache: string; date: string; resultat: "envoye" | "coupe" | "refuse" | "echec" }
export interface JournalTrace { ecrire(t: Trace): void }
export interface Cible { role: Destinataire; adresse: string }

export class EnvoiRefuse extends Error {}

// Une seule adresse, sans espace, guillemet, virgule ni saut de ligne.
const ADRESSE = /^[^\s@<>",;:()[\]\\]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;
const hacher = (adresse: string) => createHash("sha256").update(adresse.trim().toLowerCase()).digest("hex");

export interface OptionsExpediteur {
  table: readonly Envoi[];
  transport: Transport;
  interrupteurs: Interrupteurs;
  trace: JournalTrace;
}

export function creerExpediteur(o: OptionsExpediteur) {
  return {
    async envoyer(cleEnvoi: string, destinataire: Cible, variables: Record<string, string>): Promise<void> {
      const trace = (resultat: Trace["resultat"]) =>
        o.trace.ecrire({ cle: cleEnvoi, destinataireHache: hacher(String(destinataire?.adresse ?? "")), date: new Date().toISOString(), resultat });
      const refuser = (raison: string): never => {
        trace("refuse");
        throw new EnvoiRefuse(raison);
      };
      const entree = o.table.find((e) => e.evenement === cleEnvoi);
      if (!entree) return refuser("clé d'envoi absente de la table des envois");
      if (destinataire?.role !== entree.destinataire || typeof destinataire.adresse !== "string" || !ADRESSE.test(destinataire.adresse)) return refuser("destinataire refusé");
      if (!o.interrupteurs.ouvert(entree.interrupteur)) {
        trace("coupe");
        return;
      }
      let message;
      try {
        message = rendre(cleEnvoi, variables);
      } catch (e) {
        return refuser((e as Error).message);
      }
      if (!message) return refuser("gabarit absent pour cette clé");
      try {
        await o.transport.envoyer({ a: destinataire.adresse, ...message });
      } catch {
        // Le message du transport n'est jamais repris : il pourrait citer une clé ou une adresse.
        trace("echec");
        throw new EnvoiRefuse("envoi en échec");
      }
      trace("envoye");
    },
  };
}
