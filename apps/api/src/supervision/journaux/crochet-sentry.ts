import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { masquer } from "../../../../../packages/observabilite/src/nettoyage.ts";
import { ErreurApi } from "../../plugins/erreurs.js";

// Crochet Sentry (C-387) : une alerte Sentry crée UNE ligne pour le chef d'orchestre (titre masqué, lien sentry.io), rien d'autre.
// Le code ne fusionne rien et ne crée aucune PR. Le port réel (issue GitHub, qui demande un jeton) n'est pas écrit : décision de l'architecte (E3).
// Signature : HMAC-SHA256 du corps BRUT (en-tête Sentry-Hook-Signature), comparée à temps constant après contrôle de longueur ; le secret n'est jamais journalisé.
// Fermé par défaut : sans `ouvert()` vrai, 503. Un rejeu (même identifiant d'événement) arrive au port avec la même clé d'idempotence.
// Limite connue (règle 9.4) : le masquage du titre est par motifs, non exhaustif par nature.
export interface TacheSentry { idEvenement: string; titre: string; lien: string }
export interface DepsCrochetSentry {
  ouvert: () => boolean;
  secret: () => string | undefined;
  // Le port doit être idempotent sur idEvenement.
  taches: { creer(t: TacheSentry): Promise<void> };
}

const LIMITE_CORPS = 64 * 1024;
const Evenement = z.object({
  data: z.object({
    event: z.object({
      event_id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
      title: z.string().min(1).max(2000),
      web_url: z.string().max(2048),
    }),
  }),
});

function lienSentry(brut: string): string | undefined {
  try {
    const u = new URL(brut);
    const hote = u.hostname;
    if (u.protocol !== "https:" || u.username || u.password || u.port) return undefined;
    return hote === "sentry.io" || hote.endsWith(".sentry.io") ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function signatureValide(secret: string | undefined, recu: unknown, corps: Buffer): boolean {
  const attendu = createHmac("sha256", secret ?? "absent").update(corps).digest();
  const recue = typeof recu === "string" && /^[0-9a-f]{64}$/i.test(recu) ? Buffer.from(recu, "hex") : Buffer.alloc(0);
  const memeLongueur = recue.length === attendu.length;
  // timingSafeEqual exige deux tampons de même longueur : un contrôle de longueur d'abord.
  return Boolean(secret) && memeLongueur && timingSafeEqual(recue, attendu);
}

export function routeCrochetSentry(serveur: FastifyInstance, d: DepsCrochetSentry): void {
  serveur.register(async (s) => {
    s.removeAllContentTypeParsers();
    // Corps lu en octets bruts (la signature porte sur eux) ; la limite coupe avant la lecture complète.
    s.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: LIMITE_CORPS }, (_r, corps, fin) => fin(null, corps));
    s.addHook("onRequest", async () => { if (!d.ouvert()) throw new ErreurApi("porte_fermee", "Crochet indisponible."); });
    s.post("/api/console/v1/sentry/crochet", { bodyLimit: LIMITE_CORPS, logLevel: "silent" }, async (requete, reponse) => {
      const corps = Buffer.isBuffer(requete.body) ? requete.body : Buffer.alloc(0);
      if (!signatureValide(d.secret(), requete.headers["sentry-hook-signature"], corps)) return reponse.status(401).send({ erreur: { code: "signature_invalide", message: "Signature refusée.", id_trace: requete.id } });
      let json: unknown;
      try { json = JSON.parse(corps.toString("utf8")); } catch { throw new ErreurApi("schema_invalide", "Requête invalide."); }
      const r = Evenement.safeParse(json);
      const lien = r.success ? lienSentry(r.data.data.event.web_url) : undefined;
      if (!r.success || !lien) throw new ErreurApi("schema_invalide", "Requête invalide.");
      await d.taches.creer({ idEvenement: r.data.data.event.event_id, titre: masquer(r.data.data.event.title).slice(0, 200), lien });
      return reponse.status(202).send();
    });
  });
}
