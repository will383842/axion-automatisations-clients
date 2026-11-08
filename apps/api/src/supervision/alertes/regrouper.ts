// Clé de regroupement de la file d'alertes (T5-04b, B-427). Des CODES seulement : jamais un message brut (adresse, nom, texte d'erreur).
// Un texte qui n'est pas un code est REFUSÉ, jamais nettoyé : le nettoyage garderait des morceaux de contenu dans une clé visible de l'équipe.
export class ErreurRegroupement extends Error {
  constructor(readonly code: "cle_invalide") {
    super(code);
    this.name = "ErreurRegroupement";
  }
}

export interface CauseAlerte {
  cause: string;
  connecteur?: string;
  version?: string;
}

const PARTIE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const CLE_MAX = 128; // CHECK alertes_cle_regroupement_code

function code(valeur: unknown): string {
  const v = typeof valeur === "string" ? valeur.toLowerCase() : "";
  if (!PARTIE.test(v)) throw new ErreurRegroupement("cle_invalide");
  return v;
}

// <cause>:<connecteur>:<version>, les parties absentes sont omises. Le client est le tenant_id (dans l'index), pas dans la clé.
export function cleRegroupement(c: CauseAlerte): string {
  const parties = [code(c.cause)];
  if (c.connecteur !== undefined) parties.push(code(c.connecteur));
  if (c.version !== undefined) {
    if (c.connecteur === undefined) throw new ErreurRegroupement("cle_invalide");
    parties.push(code(c.version));
  }
  const cle = parties.join(":");
  if (cle.length > CLE_MAX) throw new ErreurRegroupement("cle_invalide");
  return cle;
}

// Relevés de T5-14 et T5-15 : { cause, raison }. Plusieurs raisons d'une même cause se regroupent en une alerte ; la raison est vérifiée (code) mais ne fait pas la clé.
export function depuisMesure(m: { cause: string; raison: string }): CauseAlerte {
  code(m.raison);
  return { cause: code(m.cause) };
}

// Changement de santé de T5-03 : UNE cause stable par (connecteur, version), quel que soit l'état. Les raisons (liste vide au retour au vert) sont vérifiées
// comme codes mais ne font pas la clé : sinon orange (succes_sous_95) et rouge (succes_sous_80) ouvriraient deux alertes, et le vert n'aurait plus de clé à fermer.
export const CAUSE_SANTE = "sante_instance";
export function depuisSante(s: { raisons: readonly string[]; connecteur?: string; version?: string }): CauseAlerte {
  s.raisons.forEach(code);
  return { cause: CAUSE_SANTE, ...(s.connecteur !== undefined ? { connecteur: s.connecteur } : {}), ...(s.version !== undefined ? { version: s.version } : {}) };
}
