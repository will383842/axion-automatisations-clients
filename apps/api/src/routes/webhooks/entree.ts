import type { FastifyInstance } from "fastify";
import type { Memoire } from "../../canaux/verifier-entrant.js";
import type { FileMinimale } from "../../files/files.js";
import { verifierAppel, verifierFactice } from "./verifier.js";
import { router } from "./router.js";

// Entrée publique POST /webhook/<id-opaque> (A-292, A-083). Interrupteur WEBHOOKS_OUVERTS, fermé par défaut (seules les valeurs 1 et true ouvrent).
// 202 sans corps pour tout appel accepté ; 404 identique pour inconnu, révoqué, mauvaise signature (comptés à part) ; 413 au-delà de 1 Mo ; 429 au-delà du débit.
// L'adresse (qui porte l'identifiant) n'est pas journalisée sur cette route ; le corps ne l'est jamais.
export const webhooksOuverts = (env: NodeJS.ProcessEnv): boolean => env["WEBHOOKS_OUVERTS"] === "1" || env["WEBHOOKS_OUVERTS"] === "true";

export interface WebhookConnu {
  id: string;
  tenantId: string;
  instanceId: string;
  schema: { type: "hmac"; entete: string } | { type: "secret"; entete: string };
  // Référence du secret au coffre : jamais le secret.
  secretRef: string;
  revoque: boolean;
}
export type Motif = "inconnu" | "revoque" | "signature";
export interface DepsWebhooks {
  actif: () => boolean;
  depot: { lire(id: string): Promise<WebhookConnu | null> };
  secret(ref: string): Promise<string>;
  instance(instanceId: string, tenantId: string): Promise<{ cellule: string | null; etat: string } | null>;
  memoire: Memoire;
  file(nom: string): FileMinimale;
  sceller(tenantId: string, corps: Buffer): Promise<string>;
  compter?: (motif: Motif) => void;
  debit: { parWebhook: number; global: number; fenetreMs: number };
}

const ID = /^[A-Za-z0-9_-]{22}$/;
const LIMITE_CORPS = 1024 * 1024;

export function routeWebhooks(serveur: FastifyInstance, deps: DepsWebhooks): void {
  const compteurs = new Map<string, { n: number; fin: number }>();
  const depasse = (cle: string, max: number): boolean => {
    const t = Date.now();
    const c = compteurs.get(cle);
    if (!c || c.fin <= t) { compteurs.set(cle, { n: 1, fin: t + deps.debit.fenetreMs }); return false; }
    return ++c.n > max;
  };
  serveur.register(async (s) => {
    s.removeAllContentTypeParsers();
    // Tout type de contenu est lu en octets bruts (la signature porte sur eux) ; la limite coupe avant la lecture complète.
    s.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: LIMITE_CORPS }, (_r, corps, fin) => fin(null, corps));
    s.addHook("onRequest", async (_r, reponse) => { if (!deps.actif()) return reponse.status(503).send(); });
    s.post("/webhook/:id", { bodyLimit: LIMITE_CORPS, logLevel: "silent" }, async (requete, reponse) => {
      if (depasse("global", deps.debit.global)) return reponse.status(429).header("Retry-After", "60").send();
      const corps = Buffer.isBuffer(requete.body) ? requete.body : Buffer.alloc(0);
      const id = (requete.params as { id: string }).id;
      const refus = (m: Motif) => { deps.compter?.(m); return reponse.status(404).send(); };
      const w = ID.test(id) ? await deps.depot.lire(id) : null;
      if (!w) { verifierFactice(corps); return refus("inconnu"); }
      if (depasse(`w:${w.id}`, deps.debit.parWebhook)) return reponse.status(429).header("Retry-After", "60").send();
      let secret: string;
      try { secret = await deps.secret(w.secretRef); } catch { return reponse.status(503).send(); }
      const bon = verifierAppel(w.schema, secret, requete.headers, corps);
      if (w.revoque) return refus("revoque");
      if (!bon) return refus("signature");
      try {
        const issue = await router(deps, w, requete.headers, corps);
        if (issue === "sans_cellule") return refus("inconnu");
      } catch { return reponse.status(503).send(); }
      return reponse.status(202).send();
    });
  });
}
