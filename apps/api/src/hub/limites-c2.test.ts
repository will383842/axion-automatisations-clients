import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { EN_TETES, signer } from "../../../../packages/contrats/src/commun/signature.js";
import { enregistrerCanal, LIMITE_CORPS_C2 } from "../canaux/verifier-entrant.js";
import type { CleEchange } from "../coffre/cles-echanges.js";
import { brancherErreurs } from "../plugins/erreurs.js";

// Limites et refus neutres du canal c2 (T2-16b, D2 et D3).
const MAINTENANT = 1_800_000_000;
const HUB = { kid: "rec-hub-1", secret: randomBytes(32) } satisfies CleEchange;
const CHEMIN = "/api/hub/v1/faits";

function monter(options: { debit?: { max: number; fenetreSecondes: number }; echecsAvant?: number; dedoublonner?: boolean } = {}) {
  let essais = 0;
  const serveur = Fastify({ genReqId: () => randomUUID() });
  brancherErreurs(serveur);
  const recus: unknown[] = [];
  const vus = new Set<string>();
  enregistrerCanal(
    serveur,
    "hub",
    {
      cles: { async clesAcceptees(c, s) { return c === "c2" && s === "reception" ? [HUB] : []; } },
      memoire: { async set(k) { if (vus.has(k)) return null; vus.add(k); return "OK"; } },
      actif: () => true,
      maintenant: () => MAINTENANT,
      ...(options.debit ? { debit: options.debit } : {}),
    },
    (s) => {
      s.post("/faits", async (r, reponse) => {
        if (++essais <= (options.echecsAvant ?? 0)) throw new Error("base indisponible");
        if (options.dedoublonner && recus.some((c) => JSON.stringify(c) === JSON.stringify(r.body))) return reponse.status(200).send({ statut: "duplicate" });
        recus.push(r.body);
        return reponse.status(200).send({ statut: "range" });
      });
    },
  );
  return { serveur, recus };
}
const demande = (charge: string, surcharge: { horodatage?: string; secret?: Buffer; kid?: string } = {}) => {
  const h = surcharge.horodatage ?? String(MAINTENANT);
  return {
    method: "POST" as const,
    url: CHEMIN,
    headers: { "content-type": "application/json", [EN_TETES.cle]: surcharge.kid ?? HUB.kid, [EN_TETES.horodatage]: h, [EN_TETES.signature]: signer((surcharge.secret ?? HUB.secret).toString("base64"), h, "POST", CHEMIN, charge) },
    payload: charge,
  };
};
const sansTrace = (corps: string) => { const o = JSON.parse(corps) as { erreur: Record<string, unknown> }; delete o.erreur["id_trace"]; return o; };

describe("[T2-16b] D2 : limites du canal c2", () => {
  it("[T2-16b] un corps de plus de 128 Ko répond 413 sans rien ranger ; 128 Ko pile est lu", async () => {
    expect(LIMITE_CORPS_C2).toBe(128 * 1024);
    const { serveur, recus } = monter();
    const trop = JSON.stringify({ x: "a".repeat(LIMITE_CORPS_C2) });
    expect((await serveur.inject(demande(trop))).statusCode).toBe(413);
    const pile = JSON.stringify({ x: "a".repeat(LIMITE_CORPS_C2 - 8) });
    expect(Buffer.byteLength(pile)).toBe(LIMITE_CORPS_C2);
    expect((await serveur.inject(demande(pile))).statusCode).toBe(200);
    expect(recus).toHaveLength(1);
  });

  it("[T2-16b] au-delà du débit, 429 avant toute lecture ; la fenêtre suivante repart", async () => {
    const { serveur, recus } = monter({ debit: { max: 3, fenetreSecondes: 60 } });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await serveur.inject(demande(JSON.stringify({ i })))).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429, 429]);
    expect(recus).toHaveLength(3);
  });
});

describe("[T2-16b] D3 : refus neutres", () => {
  it("[T2-16b] horodatage périmé, signature fausse et clé inconnue renvoient le même 401, au même corps", async () => {
    const { serveur, recus } = monter();
    const charge = JSON.stringify({ a: 1 });
    const perime = await serveur.inject(demande(charge, { horodatage: String(MAINTENANT - 3600) }));
    const fausse = await serveur.inject(demande(charge, { secret: randomBytes(32) }));
    const inconnue = await serveur.inject(demande(charge, { kid: "rec-hub-9" }));
    expect([perime.statusCode, fausse.statusCode, inconnue.statusCode]).toEqual([401, 401, 401]);
    expect(sansTrace(fausse.body)).toEqual(sansTrace(perime.body));
    expect(sansTrace(inconnue.body)).toEqual(sansTrace(perime.body));
    expect(recus).toHaveLength(0);
  });

  it("[T2-16b] un rejeu du même envoi signé atteint le gestionnaire, qui dédoublonne : 200 « duplicate » et rien de plus rangé", async () => {
    const { serveur, recus } = monter({ dedoublonner: true });
    const requete = demande(JSON.stringify({ a: 1 }));
    expect((await serveur.inject(requete)).json()).toEqual({ statut: "range" });
    const rejeu = await serveur.inject(requete);
    expect(rejeu.statusCode).toBe(200);
    expect(rejeu.json()).toEqual({ statut: "duplicate" });
    expect(recus).toHaveLength(1);
  });

  it("[T2-16b] un premier envoi qui échoue en 500 n'occupe pas l'anti-rejeu : le même envoi signé atteint le gestionnaire et range le fait", async () => {
    const { serveur, recus } = monter({ echecsAvant: 1 });
    const requete = demande(JSON.stringify({ a: 2 }));
    expect((await serveur.inject(requete)).statusCode).toBe(500);
    expect(recus).toHaveLength(0);
    const renvoi = await serveur.inject(requete);
    expect(renvoi.statusCode).toBe(200);
    expect(renvoi.json()).toEqual({ statut: "range" });
    expect(recus).toHaveLength(1);
  });
});
