import { lookup } from "node:dns/promises";
import { createServer, connect, type Server } from "node:net";
import { analyserCible, evaluer, type Destination, type Raison, type Resolveur } from "./regles.ts";

export interface OptionsMandataire {
  declarees: readonly Destination[];
  resoudre?: Resolveur;
  exceptions?: readonly string[];
  port?: number;
  hote?: string;
}
export interface Mandataire {
  port: number;
  // Refus comptés par raison : jamais d'hôte, de port ni de contenu.
  refus: () => Partial<Record<Raison, number>>;
  close: () => void;
}

const resoudreSysteme: Resolveur = async (h) => (await lookup(h, { all: true })).map((a) => a.address);
const REPONSES: Record<number, string> = { 200: "Connection Established", 403: "Forbidden", 405: "Method Not Allowed", 502: "Bad Gateway" };
const reponse = (code: number) => `HTTP/1.1 ${code} ${REPONSES[code]}\r\nConnection: close\r\n\r\n`;

// Seul chemin réseau de l'exécution : CONNECT vers les couples hôte:port déclarés par les connecteurs de l'instance.
export async function demarrerMandataire(opts: OptionsMandataire): Promise<Mandataire> {
  const compte: Partial<Record<Raison, number>> = {};
  const refuser = (raison: Raison) => {
    compte[raison] = (compte[raison] ?? 0) + 1;
  };
  const resoudre = opts.resoudre ?? resoudreSysteme;
  const srv: Server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    let tampon = Buffer.alloc(0);
    const surDonnees = (d: Buffer) => {
      tampon = Buffer.concat([tampon, d]);
      const fin = tampon.indexOf("\r\n\r\n");
      if (fin < 0) {
        if (tampon.length > 8192) socket.destroy();
        return;
      }
      socket.off("data", surDonnees);
      socket.pause();
      const lignes = tampon.subarray(0, fin).toString("latin1").split("\r\n");
      const reste = tampon.subarray(fin + 4);
      void traiter(lignes, reste);
    };
    const traiter = async (lignes: string[], reste: Buffer) => {
      const [methode, cible] = (lignes[0] ?? "").split(" ");
      const refus = (code: number, raison: Raison) => {
        refuser(raison);
        socket.end(reponse(code));
      };
      if (methode !== "CONNECT" || !cible) return refus(405, "methode");
      const dest = analyserCible(cible);
      if (!dest) return refus(403, "non_declare");
      const entete = lignes.slice(1).find((l) => /^host:/i.test(l))?.slice(5).trim();
      if (entete !== undefined && entete.toLowerCase() !== cible.toLowerCase()) return refus(403, "entete_incoherent");
      const v = await evaluer(dest, opts.declarees, { resoudre, ...(opts.exceptions ? { exceptions: opts.exceptions } : {}), env: process.env.NODE_ENV });
      if (!v.autorise) return refus(403, v.raison);
      const sortant = connect({ host: v.adresse, port: dest.port });
      sortant.on("error", () => socket.end(reponse(502)));
      socket.on("close", () => sortant.destroy());
      sortant.on("close", () => socket.destroy());
      sortant.once("connect", () => {
        socket.write(reponse(200));
        if (reste.length > 0) sortant.write(reste);
        socket.pipe(sortant);
        sortant.pipe(socket);
        socket.resume();
      });
    };
    socket.on("data", surDonnees);
  });
  await new Promise<void>((ok) => srv.listen(opts.port ?? 0, opts.hote ?? "127.0.0.1", ok));
  return { port: (srv.address() as { port: number }).port, refus: () => ({ ...compte }), close: () => srv.close() };
}
