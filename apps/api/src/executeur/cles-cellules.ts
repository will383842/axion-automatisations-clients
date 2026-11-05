import type { FastifyRequest } from "fastify";
import { celluleDeLaCle, emplacementCoffre } from "../../../../packages/contrats/src/c4/cellule.js";
import { ANTI_REJEU_SECONDES, EN_TETES, FENETRE_SECONDES, verifier } from "../../../../packages/contrats/src/commun/signature.js";
import type { Memoire } from "../canaux/verifier-entrant.js";
import type { CleEchange, Sens } from "../coffre/cles-echanges.js";
import { ErreurCoffre } from "../coffre/coffre.js";
import { ErreurApi } from "../plugins/erreurs.js";

// Authentification de la CELLULE (C4, A-194, A-339) : X-Axion-Cle = c4:<cellule>:<kid>, clé lue sous c4-<cellule> (sens réception), jamais la clé des jetons « ji ».
// Tout refus a la même réponse (401 signature_invalide) : clé inconnue, cellule inconnue, signature fausse, horodatage périmé, rejeu. Seul le journal garde la cause.
// Panne du coffre ou de la mémoire anti-rejeu : 503 porte_fermee, jamais d'acceptation sans contrôle.
export interface DepsCellules {
  cles: { clesAcceptees(canal: string, sens: Sens): Promise<CleEchange[]> };
  memoire: Memoire;
  maintenant?: () => number;
}
const HORODATAGE = /^[0-9]{10}$/;
const SIGNATURE = /^v1=[0-9a-f]{64}$/;
const DELAI_MEMOIRE_MS = 2000;
const refus = () => new ErreurApi("signature_invalide", "Signature invalide.");
const fermee = () => new ErreurApi("porte_fermee", "Service indisponible.");
const entete = (r: FastifyRequest, nom: string) => (typeof r.headers[nom.toLowerCase()] === "string" ? (r.headers[nom.toLowerCase()] as string) : undefined);

// Rend le code de la cellule qui signe. Les formes sont vérifiées AVANT toute lecture du coffre.
export function creerAuthentificationCellule(deps: DepsCellules): (requete: FastifyRequest) => Promise<string> {
  const maintenant = deps.maintenant ?? (() => Math.floor(Date.now() / 1000));
  return async (r) => {
    const cle = entete(r, EN_TETES.cle);
    const horodatage = entete(r, EN_TETES.horodatage);
    const signature = entete(r, EN_TETES.signature);
    const place = cle ? emplacementCoffre(cle) : null;
    const cellule = cle ? celluleDeLaCle(cle) : null;
    if (!cle || !place || !cellule || !horodatage || !signature || !HORODATAGE.test(horodatage) || !SIGNATURE.test(signature)) throw refus();
    if (Math.abs(maintenant() - Number(horodatage)) > FENETRE_SECONDES) throw refus();
    let acceptees: CleEchange[];
    try {
      acceptees = await deps.cles.clesAcceptees(place.canal, "reception");
    } catch (e) {
      // Cellule sans clé dans le coffre : même refus qu'une signature fausse (aucune réponse ne dit si une cellule existe).
      if (e instanceof ErreurCoffre && e.code === "introuvable") throw refus();
      throw fermee();
    }
    const secrets = acceptees.filter((k) => k.kid === place.kid).map((k) => ({ id: cle, secret: k.secret.toString("base64") }));
    // Le chemin est celui « tel qu'envoyé », requête comprise ; l'anti-rejeu partagé est posé ci-dessous (le rappel du contrat ne retient rien).
    const resultat = secrets.length ? verifier(secrets, { cle, horodatage, methode: r.method, chemin: r.raw.url ?? "", corps: "", signature }, maintenant(), () => false) : { ok: false as const };
    if (!resultat.ok) throw refus();
    let minuteur: NodeJS.Timeout | undefined;
    try {
      const delai = new Promise<never>((_, non) => (minuteur = setTimeout(() => non(new Error("delai")), DELAI_MEMOIRE_MS)));
      const neuf = (await Promise.race([deps.memoire.set(`anti-rejeu:${cle}:${signature}`, "1", "EX", ANTI_REJEU_SECONDES, "NX"), delai])) === "OK";
      if (!neuf) throw refus();
    } catch (e) {
      throw e instanceof ErreurApi ? e : fermee();
    } finally {
      clearTimeout(minuteur);
    }
    return cellule;
  };
}
