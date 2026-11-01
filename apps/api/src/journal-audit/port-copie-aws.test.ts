import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { creerPortCopieAws, type DepotVerrouille } from "./copie-quotidienne.js";

// Faux serveur S3 sur la boucle locale : il note les requêtes reçues et répond le statut demandé au dépôt (PUT).
const serveurs: Server[] = [];
afterEach(() => {
  for (const s of serveurs.splice(0)) s.close();
});
async function fauxS3(statutPut: number): Promise<{ endpoint: string; requetes: { methode: string; ifNoneMatch: string | undefined }[] }> {
  const requetes: { methode: string; ifNoneMatch: string | undefined }[] = [];
  const srv = createServer((req, rep) => {
    requetes.push({ methode: req.method ?? "", ifNoneMatch: req.headers["if-none-match"] as string | undefined });
    req.resume();
    // Une clé sans droit de lecture : tout autre appel que l'écriture est refusé (403), comme avec la clé dédiée de l'ADR 0048.
    rep.statusCode = req.method === "PUT" ? statutPut : 403;
    rep.end();
  });
  serveurs.push(srv);
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { endpoint: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, requetes };
}
const depot: DepotVerrouille = { compartiment: "journal-audit", cle: "2026-01-01.jsonl", octets: new Uint8Array([1]), modeRetention: "COMPLIANCE", retenirJusquA: new Date("2031-01-01T00:00:00Z") };
const identifiants = { cleAcces: "cle-essai", secret: "secret-essai" };

describe("creerPortCopieAws", () => {
  it("[A-182] le dépôt n'émet qu'une écriture conditionnelle : aucune lecture (HEAD), pour qu'une clé en écriture seule suffise", async () => {
    const { endpoint, requetes } = await fauxS3(200);
    expect(await creerPortCopieAws({ endpoint, ...identifiants }).deposer(depot)).toBe(true);
    expect(requetes.map((r) => r.methode)).toEqual(["PUT"]);
    expect(requetes[0]?.ifNoneMatch).toBe("*");
  });

  it("[C-029] une clé déjà présente (412) n'est pas une erreur : rien n'est déposé", async () => {
    const { endpoint } = await fauxS3(412);
    expect(await creerPortCopieAws({ endpoint, ...identifiants }).deposer(depot)).toBe(false);
  });

  it("[A-182] un refus 403 du dépôt sort comme « acces_refuse », sans message de la bibliothèque", async () => {
    const { endpoint } = await fauxS3(403);
    await expect(creerPortCopieAws({ endpoint, ...identifiants }).deposer(depot)).rejects.toThrow(/^acces_refuse$/);
  });
});
