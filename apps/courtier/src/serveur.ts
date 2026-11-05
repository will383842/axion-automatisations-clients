import { createServer, type Server } from "node:http";
import { ErreurRemise, remettre, type PortsRemise } from "./remise.js";

// Serveur du courtier (T4-39) : POST /remise seulement. La signature de la cellule est vérifiée par l'API (port) ;
// ce serveur ne lit pas technique/, n'écrit aucun fichier et ne renvoie jamais la raison d'un refus.
const TAILLE_MAX = 4096;
const STATUT: Record<ErreurRemise["code"], number> = { demande_invalide: 400, refusee: 403, deja_remise: 409, coffre_indisponible: 503, valeur_invalide: 502, famille_non_geree: 501 };

export interface RequeteBrute { cle: string; horodatage: string; signature: string; methode: string; chemin: string; corps: Buffer; jetonInstance: string }
export interface PortsServeur extends PortsRemise {
  // Rend le code de la cellule qui signe, ou null (signature, horodatage, rejeu : vérifiés par l'API).
  verifierSignature(r: Omit<RequeteBrute, "jetonInstance">): Promise<string | null>;
}

export function creerServeur(p: PortsServeur): Server {
  return createServer((req, res) => {
    const repondre = (statut: number, corps: unknown) => { res.writeHead(statut, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(corps)); };
    const morceaux: Buffer[] = [];
    let taille = 0;
    req.on("data", (m: Buffer) => { taille += m.length; if (taille <= TAILLE_MAX) morceaux.push(m); });
    req.on("end", () => {
      void (async () => {
        if (req.method !== "POST" || req.url !== "/remise") return repondre(404, { code: "introuvable" });
        if (taille > TAILLE_MAX) return repondre(413, { code: "demande_invalide" });
        const en = (nom: string) => { const v = req.headers[nom]; return typeof v === "string" ? v : ""; };
        const corps = Buffer.concat(morceaux);
        const cellule = await p.verifierSignature({ cle: en("x-axion-cle"), horodatage: en("x-axion-horodatage"), signature: en("x-axion-signature"), methode: "POST", chemin: "/remise", corps }).catch(() => null);
        if (!cellule) return repondre(403, { code: "refusee" });
        let brut: unknown;
        try { brut = JSON.parse(corps.toString("utf8")); } catch { return repondre(400, { code: "demande_invalide" }); }
        try {
          repondre(200, await remettre(p, { cellule, jetonInstance: /^Instance (\S+)$/.exec(en("authorization"))?.[1] ?? "" }, brut));
        } catch (e) {
          if (e instanceof ErreurRemise) return repondre(STATUT[e.code], { code: e.code });
          p.journal.tracer({ evenement: "erreur_interne", cellule, code: "interne" });
          repondre(500, { code: "interne" });
        }
      })();
    });
  });
}
