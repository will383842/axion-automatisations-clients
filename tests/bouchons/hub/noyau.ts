import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { EN_TETES, signer, verifier } from "../../../packages/contrats/src/commun/signature.ts";
import { STATUT_PAR_CODE, type CodeErreur } from "../../../packages/contrats/src/commun/erreurs.ts";

// Noyau commun des bouchons : signature, anti-rejeu, anti-doublon, pilotage. Les règles du Hub et du CRM sont dans leur serveur.
export interface Requete {
  methode: string;
  chemin: string;
  requete: URLSearchParams;
  corps: unknown;
}
export interface Reponse {
  statut: number;
  corps: unknown;
}
export interface Effet {
  route: string;
  cle: string | null;
  corps: unknown;
}
export type Noter = (route: string, corps: unknown) => void;

export const erreur = (code: CodeErreur, message: string): Reponse => ({ statut: STATUT_PAR_CODE[code], corps: { erreur: { code, message, id_trace: randomUUID() } } });

export interface OptionsNoyau {
  cles: Record<string, string>;
  maintenant?: () => number;
  traiter: (r: Requete, noter: Noter) => Reponse | Promise<Reponse>;
}

export async function demarrerNoyau(options: OptionsNoyau) {
  const maintenant = options.maintenant ?? (() => Math.floor(Date.now() / 1000));
  const vus = new Set<string>();
  const cles = new Map<string, { empreinte: string; reponse: Reponse }>();
  const effets: Effet[] = [];
  let requetes = 0;
  let coupe = false;
  let lenteur = 0;
  let tuer = false;

  const serveur: Server = createServer((req, res) => {
    const morceaux: Buffer[] = [];
    req.on("data", (d: Buffer) => morceaux.push(d));
    req.on("end", () => {
      void (async () => {
        const repondre = (r: Reponse, tete: Record<string, string> = {}) => {
          res.writeHead(r.statut, { "Content-Type": "application/json", ...tete });
          res.end(JSON.stringify(r.corps));
        };
        requetes++;
        if (lenteur) await new Promise((ok) => setTimeout(ok, lenteur));
        if (coupe) return repondre(erreur("porte_fermee", "Porte fermée."));
        const brut = Buffer.concat(morceaux);
        const methode = req.method ?? "GET";
        const cheminComplet = req.url ?? "/";
        const [chemin = "/", requete = ""] = cheminComplet.split("?");
        const cle = String(req.headers[EN_TETES.cle.toLowerCase()] ?? "");
        const signature = String(req.headers[EN_TETES.signature.toLowerCase()] ?? "");
        const secret = options.cles[cle];
        const verdict = secret
          ? verifier(secret, String(req.headers[EN_TETES.horodatage.toLowerCase()] ?? ""), methode, cheminComplet, brut, signature, maintenant())
          : ({ ok: false, code: "signature_invalide" } as const);
        if (!verdict.ok) return repondre(erreur(verdict.code, "Signature refusée."));
        // Anti-rejeu : le couple (clé, signature) ne passe qu'une fois.
        const couple = `${cle}|${signature}`;
        if (vus.has(couple)) return repondre(erreur("rejeu", "Requête déjà reçue."));
        vus.add(couple);

        let corps: unknown;
        try {
          corps = brut.length ? JSON.parse(brut.toString("utf8")) : undefined;
        } catch {
          return repondre(erreur("schema_invalide", "Corps illisible."));
        }
        const cleIdempotence = String(req.headers["idempotency-key"] ?? "");
        const empreinte = createHash("sha256").update(brut).digest("hex");
        if (methode === "POST" && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cleIdempotence)) {
          return repondre(erreur("schema_invalide", "Idempotency-Key absente ou mal formée."));
        }
        const connue = methode === "POST" ? cles.get(cleIdempotence) : undefined;
        if (connue) {
          if (connue.empreinte !== empreinte) return repondre(erreur("cle_reutilisee", "Clé déjà utilisée avec un autre corps."));
          return repondre(connue.reponse, { "Idempotency-Replayed": "true" });
        }
        const noter: Noter = (route, c) => effets.push({ route, cle: cleIdempotence || null, corps: c });
        const reponse = await options.traiter({ methode, chemin, requete: new URLSearchParams(requete), corps }, noter);
        // Seules les réponses de succès sont mémorisées : un refus de règle ne bloque pas la clé.
        if (methode === "POST" && reponse.statut < 300) cles.set(cleIdempotence, { empreinte, reponse });
        if (tuer) {
          tuer = false;
          req.socket.destroy();
          return;
        }
        repondre(reponse);
      })();
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  const port = (serveur.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    couper: () => void (coupe = true),
    rouvrir: () => void (coupe = false),
    lenteur: (ms: number) => void (lenteur = ms),
    tuerApresReception: () => void (tuer = true),
    etat: () => ({ requetes, effets: [...effets] }),
    arreter: () =>
      new Promise<void>((ok) => {
        serveur.closeAllConnections();
        serveur.close(() => ok());
      }),
  };
}

// Poussée d'un fait signé vers une URL donnée (sens Hub → console ou CRM → console). Pas d'Idempotency-Key : le récepteur dédoublonne par event_id.
export async function pousserSigne(url: string, ident: { cle: string; secret: string }, corps: unknown): Promise<Response> {
  const brut = JSON.stringify(corps);
  const horodatage = String(Math.floor(Date.now() / 1000));
  const { pathname, search } = new URL(url);
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [EN_TETES.cle]: ident.cle,
      [EN_TETES.horodatage]: horodatage,
      [EN_TETES.signature]: signer(ident.secret, horodatage, "POST", pathname + search, brut),
    },
    body: brut,
  });
}
