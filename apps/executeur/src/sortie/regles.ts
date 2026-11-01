import { isIP } from "node:net";

export interface Destination {
  hote: string;
  port: number;
}
export type Raison = "non_declare" | "adresse_interdite" | "resolution" | "entete_incoherent" | "methode";
export type Verdict = { autorise: true; adresse: string } | { autorise: false; raison: Raison };
export type Resolveur = (hote: string) => Promise<string[]>;

export interface OptionsEvaluation {
  resoudre: Resolveur;
  // Liste du socle de test : adresses privées permises, honorée seulement si env vaut « test ».
  exceptions?: readonly string[];
  env?: string | undefined;
}

const normaliser = (h: string) => h.toLowerCase().replace(/\.$/, "");

// Hôte[:port] d'un CONNECT : port obligatoire, IPv6 entre crochets, aucun caractère étranger.
export function analyserCible(cible: string): Destination | undefined {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9._-]+)):(\d{1,5})$/.exec(cible);
  const hote = m?.[1] ?? m?.[2];
  const port = Number(m?.[3]);
  if (!hote || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { hote, port };
}

function octetsV6(ip: string): number[] | undefined {
  let s = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = (v4[1] as string).split(".").map(Number);
    s = s.slice(0, -(v4[1] as string).length) + ((o[0] as number) * 256 + (o[1] as number)).toString(16) + ":" + ((o[2] as number) * 256 + (o[3] as number)).toString(16);
  }
  const [tete = "", queue, trop] = s.split("::");
  if (trop !== undefined) return undefined;
  const a = tete ? tete.split(":") : [];
  const b = queue ? queue.split(":") : [];
  if (queue === undefined ? a.length !== 8 : a.length + b.length > 7) return undefined;
  const groupes = [...a, ...Array<string>(queue === undefined ? 0 : 8 - a.length - b.length).fill("0"), ...b].map((g) => parseInt(g, 16));
  if (groupes.length !== 8 || groupes.some((g) => Number.isNaN(g))) return undefined;
  return groupes.flatMap((g) => [g >> 8, g & 255]);
}

function interditV4([a, b, c]: number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return true;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

// Boucle locale, lien local, privées, partagées, multicast, réservées. Illisible = interdit.
export function adresseInterdite(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return interditV4(ip.split(".").map(Number));
  if (v !== 6) return true;
  const o = octetsV6(ip);
  if (!o) return true;
  const [o0 = 0, o1 = 0] = o;
  if (o.slice(0, 15).every((x) => x === 0)) return true; // :: et ::1
  if (o.slice(0, 10).every((x) => x === 0) && o[10] === 255 && o[11] === 255) return interditV4(o.slice(12)); // ::ffff:a.b.c.d
  if (o.slice(0, 12).every((x) => x === 0)) return true; // compatible IPv4 (obsolète)
  if (o0 === 0x00 && o1 === 0x64) return true; // 64:ff9b::/96 (NAT64)
  return (o0 & 0xfe) === 0xfc || (o0 === 0xfe && (o1 & 0xc0) === 0x80) || o0 === 0xff; // ULA, lien local, multicast
}

// Le mandataire résout lui-même et renvoie l'adresse à joindre : le client ne choisit jamais l'adresse (rebinding DNS).
export async function evaluer(dest: Destination, declarees: readonly Destination[], opts: OptionsEvaluation): Promise<Verdict> {
  const hote = normaliser(dest.hote);
  if (!declarees.some((d) => normaliser(d.hote) === hote && d.port === dest.port)) return { autorise: false, raison: "non_declare" };
  let adresses: string[];
  try {
    adresses = isIP(hote) ? [hote] : await opts.resoudre(hote);
  } catch {
    return { autorise: false, raison: "resolution" };
  }
  const premiere = adresses[0];
  if (premiere === undefined) return { autorise: false, raison: "resolution" };
  const permises = opts.env === "test" ? (opts.exceptions ?? []) : [];
  if (adresses.some((a) => adresseInterdite(a) && !permises.includes(a))) return { autorise: false, raison: "adresse_interdite" };
  return { autorise: true, adresse: premiere };
}
