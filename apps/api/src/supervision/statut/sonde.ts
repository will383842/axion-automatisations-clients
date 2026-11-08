import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ErreurApi } from "../../plugins/erreurs.js";

// Signal de la sonde extérieure (B-444) : requête signée HMAC-SHA256 sur « <horodatage>.<corps> ». La clé vient du coffre (OpenBao), jamais d'un fichier.
// L'incident `plateforme_injoignable` est ouvert par le port `ouvrirIncident` ; son stockage est en T5-08.
export const TOLERANCE_S = 300;
export interface DepsSonde {
  ouvert: () => boolean;
  cles: () => Promise<Array<{ secret: Buffer }>>;
  ouvrirIncident: (e: { type: "plateforme_injoignable"; gravite: "critique"; detecteLe: string }) => Promise<{ id: string; nouveau: boolean }>;
  maintenant: () => number;
}

const HEX64 = /^[0-9a-f]{64}$/i;
const entete = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function routeSonde(serveur: FastifyInstance, d: DepsSonde): void {
  // Contexte isolé : le corps est lu en texte brut pour que la signature porte sur les octets reçus.
  void serveur.register(async (s) => {
    s.removeContentTypeParser("application/json");
    s.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 }, (_r, corps, fait) => fait(null, corps));
    s.post("/api/public/v1/sonde", async (requete, reponse) => {
      if (!d.ouvert()) throw new ErreurApi("porte_fermee", "Sonde indisponible.");
      const h = entete(requete.headers["x-axion-horodatage"]);
      const sig = entete(requete.headers["x-axion-signature"]);
      const corps = typeof requete.body === "string" ? requete.body : "";
      if (!h || !sig || !/^\d{1,12}$/.test(h) || !HEX64.test(sig)) throw new ErreurApi("signature_invalide", "Signature invalide.");
      if (Math.abs(d.maintenant() / 1000 - Number(h)) > TOLERANCE_S) throw new ErreurApi("horodatage_perime", "Horodatage périmé.");
      const recue = Buffer.from(sig, "hex");
      let signe = false;
      for (const cle of await d.cles()) {
        const attendue = createHmac("sha256", cle.secret).update(`${h}.${corps}`).digest();
        if (timingSafeEqual(recue, attendue)) signe = true;
      }
      if (!signe) throw new ErreurApi("signature_invalide", "Signature invalide.");
      let signal: unknown;
      try { signal = JSON.parse(corps); } catch { throw new ErreurApi("schema_invalide", "Signal invalide."); }
      if ((signal as { etat?: unknown } | null)?.etat !== "injoignable") return reponse.send({ statut: "recu" });
      await d.ouvrirIncident({ type: "plateforme_injoignable", gravite: "critique", detecteLe: new Date(d.maintenant()).toISOString() });
      return reponse.send({ statut: "incident_ouvert" });
    });
  });
}
