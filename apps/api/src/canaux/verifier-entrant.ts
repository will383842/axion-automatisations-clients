import type { FastifyInstance, FastifyRequest } from "fastify";
import { EN_TETES, verifier } from "../../../../packages/contrats/src/commun/signature.js";
import type { CleEchange, Sens } from "../coffre/cles-echanges.js";
import { ErreurApi } from "../plugins/erreurs.js";
import { journaliser, type Canal, type Journal } from "./journal-canal.js";

// Vérification des requêtes entrantes (C2 du Hub, C3 du CRM), posée sur les seules routes /api/hub/v1/* et /api/crm/v1/*.
// Le corps est lu BRUT (aucune analyse JSON avant la signature) ; le calcul est celui de packages/contrats.
const CANAUX = { hub: { canal: "c2", prefixe: "/api/hub/v1" }, crm: { canal: "c3", prefixe: "/api/crm/v1" } } as const;
const MEMOIRE_SECONDES = 600;
const DELAI_MEMOIRE_MS = 2000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ECRITURES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface Memoire {
  set(cle: string, valeur: string, ex: "EX", secondes: number, nx: "NX"): Promise<"OK" | null>;
}
export interface DepsEntrant {
  cles: { clesAcceptees(canal: string, sens: Sens): Promise<CleEchange[]> };
  memoire: Memoire;
  actif: (canal: Canal) => boolean;
  journal?: Journal;
  maintenant?: () => number;
}

declare module "fastify" {
  interface FastifyRequest {
    corpsBrut?: Buffer;
  }
}

const enTete = (r: FastifyRequest, nom: string): string | undefined => {
  const v = r.headers[nom.toLowerCase()];
  return typeof v === "string" ? v : undefined;
};

// Anti-rejeu : SET NX dans Valkey. Toute panne ou lenteur refuse (503) : jamais d'acceptation sans anti-rejeu.
async function premiereFois(memoire: Memoire, cle: string): Promise<boolean> {
  let minuteur: NodeJS.Timeout | undefined;
  try {
    const delai = new Promise<never>((_, non) => (minuteur = setTimeout(() => non(new Error("delai")), DELAI_MEMOIRE_MS)));
    return (await Promise.race([memoire.set(cle, "1", "EX", MEMOIRE_SECONDES, "NX"), delai])) === "OK";
  } catch {
    throw new ErreurApi("porte_fermee", "Service indisponible.");
  } finally {
    clearTimeout(minuteur);
  }
}

// Enregistre les routes d'un canal dans une portée à part : corps brut et vérification ne touchent aucune autre route.
export function enregistrerCanal(serveur: FastifyInstance, nom: keyof typeof CANAUX, deps: DepsEntrant, routes: (s: FastifyInstance) => void): void {
  const { canal, prefixe } = CANAUX[nom];
  const maintenant = deps.maintenant ?? (() => Math.floor(Date.now() / 1000));
  serveur.register(
    async (s) => {
      s.removeAllContentTypeParsers();
      s.addContentTypeParser("*", { parseAs: "buffer" }, (r, corps, fin) => {
        r.corpsBrut = corps as Buffer;
        fin(null, corps);
      });
      const vu = new WeakMap<FastifyRequest, { cle: string | undefined; horodatage: string | undefined }>();
      const trace = (r: FastifyRequest, resultat: string) => {
        const e = vu.get(r);
        journaliser(deps.journal, { canal, sens: "entrant", route: r.raw.url ?? "", cle: e?.cle, horodatage: e?.horodatage, resultat, id_trace: r.id });
      };

      // Porte fermée : refus avant toute lecture du corps, de la clé ou de Valkey.
      s.addHook("onRequest", async (r) => {
        vu.set(r, { cle: enTete(r, EN_TETES.cle), horodatage: enTete(r, EN_TETES.horodatage) });
        if (!deps.actif(canal)) {
          trace(r, "porte_fermee");
          throw new ErreurApi("porte_fermee", "Service indisponible.");
        }
      });

      s.addHook("preHandler", async (r) => {
        const refuser = (code: "signature_invalide" | "horodatage_perime" | "rejeu" | "schema_invalide", message: string): never => {
          trace(r, code);
          throw new ErreurApi(code, message);
        };
        const corps = r.corpsBrut ?? Buffer.alloc(0);
        const { cle: kid, horodatage, signature } = { cle: enTete(r, EN_TETES.cle), horodatage: enTete(r, EN_TETES.horodatage), signature: enTete(r, EN_TETES.signature) };
        if (!kid || !horodatage || !signature) return refuser("signature_invalide", "Signature invalide.");
        let acceptees: CleEchange[];
        try {
          acceptees = await deps.cles.clesAcceptees(canal, "reception");
        } catch {
          trace(r, "cles_indisponibles");
          throw new ErreurApi("porte_fermee", "Service indisponible.");
        }
        // Le chemin est celui « tel qu'envoyé », requête comprise : jamais normalisé.
        const secrets = acceptees.filter((k) => k.kid === kid).map((k) => k.secret.toString("base64"));
        const resultat = secrets.length ? verifier(secrets, horodatage, r.method, r.raw.url ?? "", corps, signature, maintenant()) : ({ ok: false, code: "signature_invalide" } as const);
        if (!resultat.ok) return refuser(resultat.code, resultat.code === "horodatage_perime" ? "Horodatage périmé." : "Signature invalide.");
        const neuf = await premiereFois(deps.memoire, `anti-rejeu:${kid}:${signature}`).catch((e: unknown) => {
          trace(r, "memoire_indisponible");
          throw e;
        });
        if (!neuf) return refuser("rejeu", "Requête déjà reçue.");
        const chemin = (r.raw.url ?? "").split("?")[0];
        const exempte = r.method === "POST" && nom === "hub" && chemin === `${prefixe}/faits`;
        if (ECRITURES.has(r.method) && !exempte && !UUID_V4.test(enTete(r, "idempotency-key") ?? "")) return refuser("schema_invalide", "Idempotency-Key obligatoire.");
        if (corps.length > 0) {
          try {
            r.body = JSON.parse(corps.toString("utf8"));
          } catch {
            return refuser("schema_invalide", "Corps invalide.");
          }
        } else r.body = undefined;
        trace(r, "ok");
      });

      routes(s);
    },
    { prefix: prefixe },
  );
}
