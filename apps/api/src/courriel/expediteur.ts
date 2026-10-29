import { createHmac } from "node:crypto";
import type { Destinataire, Envoi } from "../../../../packages/contrats/src/notifications/table.js";
import { rendre } from "./gabarits.js";

// Un seul chemin pour tout e-mail de service (A-116) : clé présente dans la table des envois, interrupteur ouvert, gabarit à liste blanche, trace.
// Aucun repli : si une étape manque, rien ne part. Le transport est Mailpit en CI, ZeptoMail en production.

export interface Message { de?: string; a: string; sujet: string; texte: string }
export interface Transport { envoyer(m: Message): Promise<void> }
export interface Interrupteurs { ouvert(nom: string): boolean }
export interface Trace { cle: string; destinataireHache: string; date: string; resultat: "envoye" | "coupe" | "refuse" | "echec" }
export interface JournalTrace { ecrire(t: Trace): void }
// Adresses de l'équipe, lues dans config.ts. L'appelant ne donne jamais d'adresse : il nomme un rôle.
export type Adresses = Partial<Record<Destinataire, string>>;
// Rôles de l'équipe seulement ; les rôles clients s'ouvrent avec le lot 6 (T6-24), qui apporte leurs textes et leurs adresses.
const ROLES_EQUIPE: readonly Destinataire[] = ["will"];
// Clé de la trace : secret de la plateforme, lu dans le coffre (même famille que la clé ZeptoMail).
export const SECRET_TRACE_COURRIEL = "plateforme/trace-courriel";

export class EnvoiRefuse extends Error {}

// Une seule adresse, sans espace, guillemet, virgule ni saut de ligne.
const ADRESSE = /^[^\s@<>",;:()[\]\\]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;

export interface OptionsExpediteur {
  table: readonly Envoi[];
  transport: Transport;
  interrupteurs: Interrupteurs;
  trace: JournalTrace;
  adresses: Adresses;
  cleTrace: string;
}

export function creerExpediteur(o: OptionsExpediteur) {
  if (typeof o.cleTrace !== "string" || o.cleTrace.trim() === "") throw new EnvoiRefuse("clé de trace absente : aucun envoi sans trace");
  const hacher = (adresse: string) => createHmac("sha256", o.cleTrace).update(adresse.trim().toLowerCase()).digest("hex");
  return {
    async envoyer(cleEnvoi: string, role: Destinataire, variables: Record<string, string>): Promise<void> {
      const adresse = typeof role === "string" && ROLES_EQUIPE.includes(role) && Object.hasOwn(o.adresses, role) ? o.adresses[role] : undefined;
      const trace = (resultat: Trace["resultat"]) =>
        o.trace.ecrire({ cle: cleEnvoi, destinataireHache: hacher(adresse ?? ""), date: new Date().toISOString(), resultat });
      const refuser = (raison: string): never => {
        trace("refuse");
        throw new EnvoiRefuse(raison);
      };
      const entree = o.table.find((e) => e.evenement === cleEnvoi);
      if (!entree) return refuser("clé d'envoi absente de la table des envois");
      if (role !== entree.destinataire || adresse === undefined || !ADRESSE.test(adresse)) return refuser("destinataire refusé");
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
        await o.transport.envoyer({ a: adresse, ...message });
      } catch {
        // Le message du transport n'est jamais repris : il pourrait citer une clé ou une adresse.
        trace("echec");
        throw new EnvoiRefuse("envoi en échec");
      }
      trace("envoye");
    },
  };
}
