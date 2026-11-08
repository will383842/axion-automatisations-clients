import { createHmac } from "node:crypto";
import type { Destinataire, Envoi } from "../../../../packages/contrats/src/notifications/table.js";
import { CATALOGUE_EMAILS, type TexteEmail } from "../../../../packages/contrats/src/messages/catalogue.js";
import { doitLirePreferences, type PreferencesEnvoi } from "../portail/notifications.js";
import { consommerClic, type ClicEquipe } from "./clic-equipe.js";
import { rendreClient } from "./gabarits-clients/rendre.js";
import { rendre } from "./gabarits.js";

// Un seul chemin pour tout e-mail de service (A-116) : clé présente dans la table des envois, interrupteur ouvert, gabarit à liste blanche, trace.
// Aucun repli : si une étape manque, rien ne part. Le transport est Mailpit en CI, ZeptoMail en production.

export interface Message { de?: string; a: string; sujet: string; texte: string }
export interface Transport { envoyer(m: Message): Promise<void> }
export interface Interrupteurs { ouvert(nom: string): boolean }
export interface Trace { cle: string; destinataireHache: string; date: string; resultat: "envoye" | "coupe" | "refuse" | "echec"; client?: string }
export interface JournalTrace { ecrire(t: Trace): void }
// Adresses de l'équipe, lues dans config.ts. L'appelant ne donne jamais d'adresse : il nomme un rôle.
export type Adresses = Partial<Record<Destinataire, string>>;
// Rôles de l'équipe seulement : `envoyer` ne sert jamais un client. Les clients passent par `envoyerAuClient` (T6-24b).
const ROLES_EQUIPE: readonly Destinataire[] = ["will"];
// collegue_invite reste refusé : son adresse vient de l'invitation (T6-16).
const ROLES_CLIENTS: readonly Destinataire[] = ["administrateur_client"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ports du chemin des clients. Port absent = rien ne part (échec fermé).
export interface AnnuaireClient { destinataires(tenantId: string, role: Destinataire): Promise<{ utilisateur: string; adresse: string }[]> }
export interface Conditions { verifier(tenantId: string, condition: string): Promise<boolean> }
export type { PreferencesEnvoi };
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
  // Chemin des clients (envoyerAuClient) : tout est optionnel et fermé par défaut.
  textes?: Readonly<Record<string, TexteEmail>>;
  annuaire?: AnnuaireClient;
  preferences?: PreferencesEnvoi;
  conditions?: Conditions;
  originePortail?: string;
  // Domaines jamais servis. La valeur réelle vit dans la configuration privée du serveur, jamais dans ce dépôt.
  domainesRefuses?: readonly string[];
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
    // Envoi à un client : adresses lues dans l'annuaire du client demandé, jamais données par l'appelant.
    async envoyerAuClient(cleEnvoi: string, cible: { tenantId: string; role: Destinataire }, variables: Record<string, string>, clic?: ClicEquipe): Promise<void> {
      const tenantId = typeof cible?.tenantId === "string" ? cible.tenantId : "";
      const tracer = (resultat: Trace["resultat"], adresse = "") =>
        o.trace.ecrire({ cle: cleEnvoi, destinataireHache: hacher(adresse), date: new Date().toISOString(), resultat, client: UUID.test(tenantId) ? tenantId : "invalide" });
      const refuser = (raison: string, adresse = ""): never => {
        tracer("refuse", adresse);
        throw new EnvoiRefuse(raison);
      };
      const entree = o.table.find((e) => e.evenement === cleEnvoi);
      if (!entree) return refuser("clé d'envoi absente de la table des envois");
      const role = cible.role;
      if (typeof role !== "string" || role !== entree.destinataire || !ROLES_CLIENTS.includes(role)) return refuser("destinataire refusé");
      if (!UUID.test(tenantId)) return refuser("client invalide");
      if (entree.mode === "clic_will" && !consommerClic(clic, cleEnvoi)) return refuser("envoi d'un clic de l'équipe sans preuve de clic");
      for (const condition of entree.conditions ?? []) {
        if (!o.conditions) return refuser("conditions non vérifiables");
        let remplie = false;
        try {
          remplie = (await o.conditions.verifier(tenantId, condition)) === true;
        } catch {
          return refuser("conditions non vérifiables");
        }
        if (!remplie) {
          // Condition fausse : situation normale (ex. incident ouvert), rien ne part.
          tracer("refuse");
          return;
        }
      }
      if (!o.interrupteurs.ouvert(entree.interrupteur)) {
        tracer("coupe");
        return;
      }
      const texte = entree.cleTexte === null ? undefined : ((o.textes ?? CATALOGUE_EMAILS) as Readonly<Record<string, TexteEmail>>)[entree.cleTexte];
      if (!texte) return refuser("texte absent du catalogue");
      if (texte.validation === "a_valider") return refuser("texte non validé par Will");
      let message;
      try {
        message = rendreClient(texte, variables, o.originePortail === undefined ? {} : { originePortail: o.originePortail });
      } catch (e) {
        return refuser((e as Error).message);
      }
      if (!o.annuaire) return refuser("annuaire absent");
      let liste: { utilisateur: string; adresse: string }[];
      try {
        liste = await o.annuaire.destinataires(tenantId, role);
      } catch {
        return refuser("annuaire en échec");
      }
      if (!Array.isArray(liste) || liste.length === 0) return refuser("aucun destinataire");
      let enEchec = false;
      for (const { utilisateur, adresse } of liste) {
        if (typeof adresse !== "string" || !ADRESSE.test(adresse)) {
          tracer("refuse");
          continue;
        }
        const domaine = adresse.slice(adresse.lastIndexOf("@") + 1).toLowerCase();
        if ((o.domainesRefuses ?? []).some((d) => domaine === d.toLowerCase() || domaine.endsWith(`.${d.toLowerCase()}`))) {
          tracer("refuse", adresse);
          continue;
        }
        if (doitLirePreferences(entree.evenement)) {
          try {
            if (!o.preferences) throw new Error("préférences absentes");
            if (await o.preferences.coupee(tenantId, utilisateur, entree.evenement)) {
              tracer("coupe", adresse);
              continue;
            }
          } catch {
            tracer("echec", adresse);
            continue;
          }
        }
        try {
          await o.transport.envoyer({ a: adresse, ...message });
        } catch {
          // Le message du transport n'est jamais repris : il pourrait citer une clé ou une adresse.
          tracer("echec", adresse);
          enEchec = true;
          continue;
        }
        tracer("envoye", adresse);
      }
      if (enEchec) throw new EnvoiRefuse("envoi en échec");
    },
  };
}
