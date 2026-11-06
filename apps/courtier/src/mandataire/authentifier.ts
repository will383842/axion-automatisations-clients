import type { Duplex } from "node:stream";
import type { PorteeJeton, RegistreJetons } from "../jetons.js";
import { ErreurMandataire } from "./relayer.js";

// Authentification de l'exécuteur auprès du mandataire (T4-41) : utilisateur = identifiant d'instance, mot de passe = jeton court (T4-39).
// Jeton inconnu, expiré, d'une autre instance ou identifiant mal formé : la même réponse, sans dire lequel.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Ce que le mandataire sait d'une connexion de messagerie : l'hôte, le port et l'identifiant viennent d'ici, jamais de l'exécuteur.
export interface ConnexionMessagerie {
  tenantId: string;
  instanceId: string;
  connexionId: string;
  hote: string;
  port: number;
  identifiant: string;
  referenceCoffre: string;
}
export interface PortsMandataire {
  jetons: Pick<RegistreJetons, "lire">;
  // Lecture de la connexion sous RLS ; le client vient de la base.
  connexion(instanceId: string, connexionId: string): Promise<ConnexionMessagerie | undefined>;
  // Lecture du mot de passe d'application dans OpenBao par la référence de la connexion.
  lireMotDePasse(c: ConnexionMessagerie): Promise<string>;
  // Connexion sortante en TLS, certificat vérifié (ouvrirTlsVerifie).
  ouvrir(cible: { hote: string; port: number }): Promise<Duplex>;
  journaliser(ligne: string): void;
  maintenant(): number;
}

// Décode une réponse SASL PLAIN : [autorisation] NUL utilisateur NUL jeton. Base64 strict, trois champs, autorisation vide ou égale à l'utilisateur.
export function decoderPlain(b64: string): { utilisateur: string; jeton: string } | null {
  if (typeof b64 !== "string" || b64.length > 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  const brut = Buffer.from(b64, "base64");
  if (brut.toString("base64") !== b64) return null;
  const parties = brut.toString("latin1").split("\0");
  if (parties.length !== 3) return null;
  const [autorisation, utilisateur, jeton] = parties as [string, string, string];
  return autorisation === "" || autorisation === utilisateur ? { utilisateur, jeton } : null;
}

export function authentifier(p: PortsMandataire, utilisateur: string, jeton: string): PorteeJeton | null {
  if (!UUID.test(utilisateur)) return null;
  const portee = p.jetons.lire(jeton);
  return portee && portee.instanceId === utilisateur ? portee : null;
}

// Rend la connexion DU jeton et son mot de passe, ou lève un refus : client de la base différent du client du jeton = refus.
export async function ouvrirDepuisJeton(p: PortsMandataire, portee: PorteeJeton): Promise<{ connexion: ConnexionMessagerie; motDePasse: string }> {
  let connexion: ConnexionMessagerie | undefined;
  let motDePasse: string;
  try {
    connexion = await p.connexion(portee.instanceId, portee.connexionId);
    if (!connexion || connexion.tenantId !== portee.tenantId || connexion.instanceId !== portee.instanceId || connexion.connexionId !== portee.connexionId) throw new ErreurMandataire("refuse");
    motDePasse = await p.lireMotDePasse(connexion);
  } catch (e) {
    throw e instanceof ErreurMandataire ? e : new ErreurMandataire("indisponible");
  }
  if (typeof motDePasse !== "string" || motDePasse === "" || /[\0\r\n]/.test(motDePasse + connexion.identifiant)) throw new ErreurMandataire("indisponible");
  return { connexion, motDePasse };
}

export const secretsDe = (identifiant: string, motDePasse: string): string[] => [motDePasse, Buffer.from(motDePasse).toString("base64"), Buffer.from(`\0${identifiant}\0${motDePasse}`).toString("base64")];
export const reponsePlain = (identifiant: string, motDePasse: string): string => Buffer.from(`\0${identifiant}\0${motDePasse}`).toString("base64");
