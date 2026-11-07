import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Faux Sentry HTTP réel sur 127.0.0.1 (port libre) : il garde le corps BRUT de chaque requête reçue,
// pour chercher un marqueur dans l'enveloppe entière. Aucun DSN réel, aucun réseau externe.
export interface FauxSentry {
  readonly corps: string[];
  readonly adresses: string[];
  fermer(): Promise<void>;
  // Fetch injecté : redirige toute adresse https vers ce faux serveur (le DSN reste en *.de.sentry.io).
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export async function demarrerFauxSentry(): Promise<FauxSentry> {
  const corps: string[] = [];
  const adresses: string[] = [];
  const serveur: Server = createServer((req, res) => {
    const morceaux: Buffer[] = [];
    req.on("data", (m: Buffer) => morceaux.push(m));
    req.on("end", () => {
      corps.push(Buffer.concat(morceaux).toString("utf8"));
      adresses.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
  return {
    corps,
    adresses,
    fermer: () => new Promise<void>((ok) => { serveur.closeAllConnections(); serveur.close(() => ok()); }),
    fetch: (url, init) => globalThis.fetch(url.replace(/^https?:\/\/[^/]+/, base), init),
  };
}

// Fetch d'un Sentry injoignable : ne répond jamais, ne rend la main qu'à l'abandon.
export const fetchInjoignable = (_url: string, init: RequestInit): Promise<Response> =>
  new Promise((_ok, ko) => {
    init.signal?.addEventListener("abort", () => ko(init.signal?.reason ?? new Error("abandon")));
  });
