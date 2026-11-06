import type { FastifyInstance, FastifyRequest } from "fastify";
import { celluleDeLaCle, controlerPaquet, emplacementCoffre } from "../../../../../packages/contrats/src/c4/cellule.js";
import { Paquet } from "../../../../../packages/contrats/src/c4/evenements-executeur.js";
import { ANTI_REJEU_SECONDES, EN_TETES, FENETRE_SECONDES, verifier } from "../../../../../packages/contrats/src/commun/signature.js";
import type { CleEchange } from "../../coffre/cles-echanges.js";
import { ErreurCoffre } from "../../coffre/coffre.js";
import type { DepotExecutions } from "../../executeur/ranger-evenements.js";
import { dansLesBornes, rangerPaquet } from "../../executeur/ranger-evenements.js";
import { ErreurApi } from "../../plugins/erreurs.js";
import type { Contexte } from "./index.js";

// POST /evenements (A-343, A-344, A-346) : signature de la cellule SUR LE CORPS BRUT, puis schéma strict de C4, puis cellule de CHAQUE instance.
// Un seul écart (instance d'une autre cellule, inconnue, signal de vie au nom d'une autre cellule) : le paquet ENTIER est refusé, rien n'est rangé.
// Le code 403 action_interdite est celui du contrat (cellule.ts, controlerPaquet), qui fait foi sur la fiche (422 regle_metier).
export interface DepsEvenements {
  depot: DepotExecutions;
  // Incident compté à part (métrique) ; jamais de contenu.
  compter?: (nom: string) => void;
}
export const CORPS_MAX = 1_048_576;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HORODATAGE = /^[0-9]{10}$/;
const SIGNATURE = /^v1=[0-9a-f]{64}$/;
const refus = () => new ErreurApi("signature_invalide", "Signature invalide.");
const fermee = () => new ErreurApi("porte_fermee", "Service indisponible.");
const entete = (r: FastifyRequest, nom: string) => (typeof r.headers[nom.toLowerCase()] === "string" ? (r.headers[nom.toLowerCase()] as string) : undefined);

// Même contrôle que creerAuthentificationCellule (GET, corps vide), mais la signature couvre les octets reçus.
async function authentifier(ctx: Contexte, r: FastifyRequest, corps: Buffer): Promise<{ cle: string; cellule: string }> {
  const cle = entete(r, EN_TETES.cle);
  const horodatage = entete(r, EN_TETES.horodatage);
  const signature = entete(r, EN_TETES.signature);
  const place = cle ? emplacementCoffre(cle) : null;
  const cellule = cle ? celluleDeLaCle(cle) : null;
  if (!cle || !place || !cellule || !horodatage || !signature || !HORODATAGE.test(horodatage) || !SIGNATURE.test(signature)) throw refus();
  const maintenant = ctx.deps.maintenant ?? (() => Math.floor(Date.now() / 1000));
  if (Math.abs(maintenant() - Number(horodatage)) > FENETRE_SECONDES) throw refus();
  let acceptees: CleEchange[];
  try {
    acceptees = await ctx.deps.cles.clesAcceptees(place.canal, "reception");
  } catch (e) {
    if (e instanceof ErreurCoffre && e.code === "introuvable") throw refus();
    throw fermee();
  }
  const secrets = acceptees.filter((k) => k.kid === place.kid).map((k) => ({ id: cle, secret: k.secret.toString("base64") }));
  const v = secrets.length ? verifier(secrets, { cle, horodatage, methode: r.method, chemin: r.raw.url ?? "", corps, signature }, maintenant(), () => false) : { ok: false as const };
  if (!v.ok) throw refus();
  let neuf: boolean;
  try {
    neuf = (await ctx.deps.memoire.set(`anti-rejeu:${cle}:${signature}`, "1", "EX", ANTI_REJEU_SECONDES, "NX")) === "OK";
  } catch {
    throw fermee();
  }
  if (!neuf) throw refus();
  return { cle, cellule };
}

export function routeEvenements(s: FastifyInstance, ctx: Contexte, deps: DepsEvenements): void {
  // Corps gardé en octets : la signature porte dessus, jamais sur une réécriture. Au-delà de 1 Mo : refus avant lecture complète.
  s.removeContentTypeParser("application/json");
  s.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: CORPS_MAX }, (_r, corps, fait) => fait(null, corps));
  s.post("/evenements", { bodyLimit: CORPS_MAX }, async (requete, reponse) => {
    const corps = Buffer.isBuffer(requete.body) ? requete.body : Buffer.alloc(0);
    const { cle, cellule } = await authentifier(ctx, requete, corps);
    if (!UUID_V4.test(entete(requete, EN_TETES.idempotence) ?? "")) throw new ErreurApi("schema_invalide", "Idempotency-Key obligatoire.");
    let json: unknown;
    try {
      json = JSON.parse(corps.toString("utf8"));
    } catch {
      throw new ErreurApi("schema_invalide", "Requête invalide.");
    }
    const paquet = Paquet.safeParse(json);
    if (!paquet.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    // La cellule de chaque instance vient de la base, jamais de la requête.
    const instances = new Map<string, Awaited<ReturnType<Contexte["deps"]["depot"]["resoudre"]>>>();
    for (const e of paquet.data.evenements) {
      const id = e.instanceId.toLowerCase();
      if (!instances.has(id)) instances.set(id, await ctx.deps.depot.resoudre(id));
    }
    const verdict = controlerPaquet(cle, paquet.data, (id) => instances.get(id.toLowerCase())?.celluleCode ?? null);
    if (!verdict.ok) {
      deps.compter?.("paquet_hors_cellule");
      throw new ErreurApi("action_interdite", "Action interdite.");
    }
    if (!dansLesBornes(paquet.data)) throw new ErreurApi("regle_metier", "Valeur hors des bornes.");
    await rangerPaquet(deps.depot, paquet.data, cellule, (id) => instances.get(id.toLowerCase())!);
    return reponse.status(202).send({ acceptes: paquet.data.evenements.length });
  });
}
