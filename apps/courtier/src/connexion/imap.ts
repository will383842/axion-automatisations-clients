// Connexion IMAP (T4-42b, A-390) : le formulaire du courtier envoie le mot de passe d'application DIRECTEMENT au coffre, puis la connexion est testée.
// Aucune fonction ne rend le mot de passe. Fichier autonome : seulement des types locaux (les ports sont câblés plus tard, dette D1).
export type Planifier = (f: () => void, ms: number) => () => void;
export interface CompteImap { hote: string; port: number; chiffrement: "tls" | "starttls"; identifiant: string }
export type ResultatTest = { ok: true } | { ok: false; code: string };
export interface PortsImap {
  // Interrupteur ouvert ET fiche de conformité signée pour cet outil (câblage : dette D1).
  porte(outil: string): boolean;
  // UPDATE conditionnel de la base (a_tester, jamais testée) : vrai pour un seul appelant.
  reclamer(tenantId: string, connexionId: string, acteur: string): Promise<boolean>;
  ecrireCoffre(chemin: string, valeur: Readonly<Record<string, string | number>>): Promise<void>;
  testerImap(compte: CompteImap, motDePasse: string): Promise<ResultatTest>;
  marquerEtat(tenantId: string, connexionId: string, acteur: string, etat: "active" | "en_echec", code: string): Promise<void>;
  journal: { tracer(evenement: Record<string, string>): void };
  planifier?: Planifier;
}
export interface OuvertureImap { tenantId: string; connexionId: string; outil: string; acteur: string }
export type ReponseImap = { etat: "active" | "en_echec" | "refusee"; code: string };

// Chemins déterministes par connexion ; le renouvellement ne réécrit que « jetons » (plan 2.1).
export const cheminJetons = (tenantId: string, connexionId: string): string => `clients/${tenantId}/connexions/${connexionId}/jetons`;
export const cheminCompte = (tenantId: string, connexionId: string): string => `clients/${tenantId}/connexions/${connexionId}/compte`;

const HOTE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const PORT_PAR_CHIFFREMENT = { tls: 993, starttls: 143 } as const;
const CHAMPS = ["chiffrement", "hote", "identifiant", "mot_de_passe", "port"];
const HOTE_GOOGLE = /(^|\.)(gmail\.com|googlemail\.com)$/i;
const DELAI_TEST_MS = 5_000;
const planifierReel: Planifier = (f, ms) => { const t = setTimeout(f, ms); return () => clearTimeout(t); };

function lire(brut: unknown): (CompteImap & { motDePasse: string }) | null {
  if (typeof brut !== "object" || brut === null || Array.isArray(brut)) return null;
  const f = brut as Record<string, unknown>;
  if (Object.keys(f).sort().join() !== CHAMPS.join()) return null;
  const { hote, port, chiffrement, identifiant, mot_de_passe: mdp } = f;
  if (typeof hote !== "string" || !HOTE.test(hote)) return null;
  if (chiffrement !== "tls" && chiffrement !== "starttls") return null;
  const attendu = PORT_PAR_CHIFFREMENT[chiffrement];
  if (port !== attendu) return null;
  if (typeof identifiant !== "string" || identifiant.trim() === "" || identifiant.length > 256 || /[\0\r\n]/.test(identifiant)) return null;
  if (typeof mdp !== "string" || mdp.length < 1 || mdp.length > 256 || /[\0\r\n]/.test(mdp)) return null;
  return { hote, port: attendu, chiffrement, identifiant, motDePasse: mdp };
}

// Délai maximal d'un appel (recopié de remise.ts : aucun import hors de connexion/).
async function avecDelai<T>(appel: () => Promise<T>, ms: number, planifier: Planifier): Promise<T> {
  let annuler = () => undefined as void;
  const echeance = new Promise<never>((_, ko) => { annuler = planifier(() => ko(new Error("delai")), ms); });
  try {
    return await Promise.race([appel(), echeance]);
  } finally {
    annuler();
  }
}

export async function relierImap(p: PortsImap, o: OuvertureImap, formulaire: unknown): Promise<ReponseImap> {
  const refuser = (code: string): ReponseImap => ({ etat: "refusee", code });
  if (!p.porte(o.outil)) return refuser("porte_fermee");
  const f = lire(formulaire);
  if (!f) return refuser("formulaire_invalide");
  // Hôte de Google : seulement sur une connexion « gmail », dont l'attestation de l'administrateur Workspace est tracée à la création du lien.
  if (HOTE_GOOGLE.test(f.hote) && o.outil !== "gmail") return refuser("attestation_absente");
  const { motDePasse, ...compte } = f;
  const tracer = (evenement: string, code: string) => p.journal.tracer({ evenement, tenantId: o.tenantId, connexionId: o.connexionId, code });
  // La réclamation passe AVANT toute écriture au coffre.
  if (!(await p.reclamer(o.tenantId, o.connexionId, o.acteur))) { tracer("connexion_refusee", "deja_utilise"); return refuser("deja_utilise"); }
  const fin = async (etat: "active" | "en_echec", code: string): Promise<ReponseImap> => {
    await p.marquerEtat(o.tenantId, o.connexionId, o.acteur, etat, code);
    tracer(etat === "active" ? "connexion_reliee" : "connexion_refusee", code);
    return { etat, code };
  };
  try {
    await p.ecrireCoffre(cheminJetons(o.tenantId, o.connexionId), { mot_de_passe: motDePasse });
    await p.ecrireCoffre(cheminCompte(o.tenantId, o.connexionId), compte);
  } catch {
    return fin("en_echec", "ecriture_echouee");
  }
  const essai = await avecDelai(() => p.testerImap(compte, motDePasse), DELAI_TEST_MS, p.planifier ?? planifierReel).catch((): ResultatTest => ({ ok: false, code: "delai" }));
  return essai.ok ? fin("active", "ok") : fin("en_echec", essai.code);
}
