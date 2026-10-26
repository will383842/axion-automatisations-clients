import type { FastifyInstance, FastifyRequest } from "fastify";
import { EN_TETES, FENETRE_SECONDES, verifier } from "../../../../packages/contrats/src/commun/signature.js";
import type { CleEchange, Sens } from "../coffre/cles-echanges.js";
import { ErreurApi } from "../plugins/erreurs.js";
import { journaliser, type Canal, type Journal } from "./journal-canal.js";

// Vérification des requêtes entrantes (C2 du Hub, C3 du CRM), posée sur les seules routes /api/hub/v1/* et /api/crm/v1/*.
// Le corps est lu BRUT (aucune analyse JSON avant la signature) ; le calcul est celui de packages/contrats.
const CANAUX = { hub: { canal: "c2", prefixe: "/api/hub/v1" }, crm: { canal: "c3", prefixe: "/api/crm/v1" } } as const;
// Strictement plus que 2 × la fenêtre (±300 s, bornes comprises) + 1 s d'arrondi, avec une marge pour les horloges décalées.
const MEMOIRE_SECONDES = 2 * FENETRE_SECONDES + 60;
// Formes vérifiées avant toute lecture du coffre : un refus ne coûte rien.
const HORODATAGE = /^[0-9]{10}$/;
const SIGNATURE = /^v1=[0-9a-f]{64}$/;
const KID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KID_MAX = 64;
const DELAI_MEMOIRE_MS = 2000;
// Clés de réception gardées par canal (la fiche admet 5 min au plus) ; un kid inconnu ne relit pas plus d'une fois par délai.
const CLES_MEMOIRE_SECONDES = 30;
const RELECTURE_MIN_SECONDES = 5;
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
      // Analyseur JSON de Fastify (refuse __proto__ et constructor.prototype), appelé seulement après la signature.
      const analyser = serveur.getDefaultJsonParser("error", "error");
      s.addContentTypeParser("*", { parseAs: "buffer" }, (r, corps, fin) => {
        r.corpsBrut = corps as Buffer;
        fin(null, corps);
      });
      // Mémoire des clés de réception : une lecture en cours à la fois, partagée par toutes les requêtes.
      let gardees: { cles: CleEchange[]; luLe: number } | undefined;
      let enCours: Promise<CleEchange[]> | undefined;
      const lire = (): Promise<CleEchange[]> =>
        (enCours ??= deps.cles
          .clesAcceptees(canal, "reception")
          .then((cles) => {
            gardees = { cles, luLe: maintenant() };
            return cles;
          })
          .finally(() => {
            enCours = undefined;
          }));
      const clesDeReception = async (kid: string): Promise<CleEchange[]> => {
        const age = gardees ? maintenant() - gardees.luLe : Infinity;
        if (gardees && age < RELECTURE_MIN_SECONDES) return gardees.cles;
        if (gardees && age < CLES_MEMOIRE_SECONDES && gardees.cles.some((k) => k.kid === kid)) return gardees.cles;
        return lire();
      };
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

      // preValidation : avant la validation du schéma du corps, qui ne doit jamais voir une requête non authentifiée.
      s.addHook("preValidation", async (r) => {
        const refuser = (code: "signature_invalide" | "horodatage_perime" | "rejeu" | "schema_invalide", message: string): never => {
          trace(r, code);
          throw new ErreurApi(code, message);
        };
        const corps = r.corpsBrut ?? Buffer.alloc(0);
        const { cle: kid, horodatage, signature } = { cle: enTete(r, EN_TETES.cle), horodatage: enTete(r, EN_TETES.horodatage), signature: enTete(r, EN_TETES.signature) };
        if (!kid || !horodatage || !signature) return refuser("signature_invalide", "Signature invalide.");
        // Contrôles peu coûteux d'abord : forme et fenêtre d'horodatage, sans lire OpenBao.
        if (!HORODATAGE.test(horodatage) || !SIGNATURE.test(signature) || kid.length > KID_MAX || !KID.test(kid)) return refuser("signature_invalide", "Signature invalide.");
        if (Math.abs(maintenant() - Number(horodatage)) > FENETRE_SECONDES) return refuser("horodatage_perime", "Horodatage périmé.");
        let acceptees: CleEchange[];
        try {
          acceptees = await clesDeReception(kid);
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
            r.body = await new Promise((ok, non) => analyser(r, corps.toString("utf8"), (e, v) => (e ? non(e) : ok(v))));
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
