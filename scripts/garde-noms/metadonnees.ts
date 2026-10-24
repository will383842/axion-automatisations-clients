import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

// Métadonnées texte d'une image (C-611) : liste FERMÉE de blocs permis, tout le reste est refusé.
// La réponse dit seulement quelle règle a refusé, jamais le contenu (C-531). N'importe que node:* (N1).
// Le texte dessiné dans les pixels n'est pas lu (risque accepté, ADR 0001).

const ok = null;
const non = (raison: string): string => raison;
const u32 = (o: Uint8Array, i: number): number => ((o[i] ?? 0) * 0x1000000) + (((o[i + 1] ?? 0) << 16) | ((o[i + 2] ?? 0) << 8) | (o[i + 3] ?? 0));
const l32 = (o: Uint8Array, i: number): number => ((o[i + 3] ?? 0) * 0x1000000) + (((o[i + 2] ?? 0) << 16) | ((o[i + 1] ?? 0) << 8) | (o[i] ?? 0));
const ascii = (o: Uint8Array, i: number, n: number): string => String.fromCharCode(...o.subarray(i, i + n));
const egal = (o: Uint8Array, i: number, octets: number[]): boolean => octets.every((b, k) => o[i + k] === b);

const PNG_PERMIS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "pHYs", "sBIT", "bKGD", "acTL", "fcTL", "fdAT"]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(o: Uint8Array): string | null {
  if (!egal(o, 0, PNG_SIGNATURE)) return non("png : signature absente");
  let i = 8;
  let premier = true;
  while (i + 12 <= o.length) {
    const longueur = u32(o, i);
    const type = ascii(o, i + 4, 4);
    if (!PNG_PERMIS.has(type)) return non(`png : bloc ${/^[A-Za-z]{4}$/.test(type) ? type : "inconnu"}`);
    if (premier && type !== "IHDR") return non("png : IHDR absent en tête");
    premier = false;
    i += 12 + longueur;
    if (i > o.length) return non("png : bloc tronqué");
    if (type === "IEND") return i === o.length ? ok : non("png : octets après IEND");
  }
  return non("png : IEND absent");
}

const JPEG_AVEC_LONGUEUR = (m: number): boolean =>
  m === 0xdb || m === 0xc4 || m === 0xdd || m === 0xda || (m >= 0xc0 && m <= 0xcf && m !== 0xc8 && m !== 0xcc);

function jpeg(o: Uint8Array): string | null {
  if (!egal(o, 0, [0xff, 0xd8])) return non("jpeg : SOI absent");
  let i = 2;
  let jfif = false;
  while (i < o.length) {
    if (o[i] !== 0xff) return non("jpeg : marqueur attendu");
    while (o[i] === 0xff) i++; // octets de remplissage
    const m = o[i] ?? 0;
    i++;
    if (m === 0xd9) return i === o.length ? ok : non("jpeg : octets après EOI");
    if (m >= 0xd0 && m <= 0xd7) continue; // RSTn, sans longueur
    const longueur = ((o[i] ?? 0) << 8) | (o[i + 1] ?? 0);
    if (m === 0xe0 && !jfif && i === 4 && egal(o, i + 2, [0x4a, 0x46, 0x49, 0x46, 0x00])) {
      // JFIF borné : 16 octets + une vignette RVB de Xt × Yt pixels, rien d'autre
      if (longueur !== 16 + 3 * (o[i + 14] ?? 0) * (o[i + 15] ?? 0)) return non("jpeg : APP0 JFIF de longueur inattendue");
      jfif = true;
    }
    else if (!JPEG_AVEC_LONGUEUR(m)) return non(`jpeg : segment ${m.toString(16)}`);
    if (longueur < 2 || i + longueur > o.length) return non("jpeg : segment tronqué");
    i += longueur;
    if (m === 0xda) {
      // données entropiques : jusqu'au prochain marqueur qui n'est ni 00 ni RSTn
      while (i < o.length && !(o[i] === 0xff && (o[i + 1] ?? 0) !== 0 && !((o[i + 1] ?? 0) >= 0xd0 && (o[i + 1] ?? 0) <= 0xd7))) i++;
    }
  }
  return non("jpeg : EOI absent");
}

const WEBP_PERMIS = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);

function morceauxWebp(o: Uint8Array, debut: number, fin: number): string | null {
  let i = debut;
  while (i < fin) {
    if (i + 8 > fin) return non("webp : bloc tronqué");
    const type = ascii(o, i, 4);
    const taille = l32(o, i + 4);
    if (!WEBP_PERMIS.has(type)) return non(`webp : bloc ${/^[A-Za-z0-9 ]{4}$/.test(type) ? type.trim() : "inconnu"}`);
    const finDonnees = i + 8 + taille;
    if (finDonnees > fin) return non("webp : bloc tronqué");
    if (type === "ANMF") {
      if (taille < 16) return non("webp : ANMF trop court");
      const interne = morceauxWebp(o, i + 8 + 16, finDonnees);
      if (interne) return interne;
    }
    i = finDonnees + (taille % 2);
  }
  return i === fin ? ok : non("webp : bloc tronqué");
}

function webp(o: Uint8Array): string | null {
  if (ascii(o, 0, 4) !== "RIFF" || ascii(o, 8, 4) !== "WEBP") return non("webp : en-tête absent");
  if (l32(o, 4) + 8 !== o.length) return non("webp : octets après la fin du RIFF ou fichier tronqué");
  return morceauxWebp(o, 12, o.length);
}

// Sous-blocs d'un GIF : suite de [taille, données…] terminée par une taille 0. Renvoie la position après le 0, ou -1.
function sousBlocs(o: Uint8Array, i: number): number {
  while (i < o.length) {
    const taille = o[i] ?? 0;
    i += 1 + taille;
    if (taille === 0) return i <= o.length ? i : -1;
  }
  return -1;
}

function gif(o: Uint8Array): string | null {
  const version = ascii(o, 0, 6);
  if (version !== "GIF87a" && version !== "GIF89a") return non("gif : en-tête absent");
  const drapeaux = o[10] ?? 0;
  let i = 13 + (drapeaux & 0x80 ? 3 * 2 ** ((drapeaux & 7) + 1) : 0);
  while (i < o.length) {
    const b = o[i];
    if (b === 0x3b) return i + 1 === o.length ? ok : non("gif : octets après le « ; » final");
    if (b === 0x2c) {
      const local = o[i + 9] ?? 0;
      i += 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0) + 1; // + taille minimale de code LZW
      i = sousBlocs(o, i);
      if (i < 0) return non("gif : image tronquée");
    } else if (b === 0x21 && o[i + 1] === 0xf9) {
      if (!egal(o, i, [0x21, 0xf9, 0x04]) || o[i + 7] !== 0) return non("gif : extension de contrôle graphique mal formée");
      i += 8;
    } else if (b === 0x21 && o[i + 1] === 0xff) {
      // seule forme permise : 0x0B « NETSCAPE2.0 », un sous-bloc de 3 octets, fin
      if (o[i + 2] !== 0x0b || ascii(o, i + 3, 11) !== "NETSCAPE2.0" || o[i + 14] !== 3 || o[i + 18] !== 0) return non("gif : extension d'application interdite");
      i += 19;
    } else if (b === 0x21) {
      return non(`gif : extension ${(o[i + 1] ?? 0).toString(16)} interdite`);
    } else {
      return non("gif : octet inattendu");
    }
  }
  return non("gif : fin absente");
}

function ico(o: Uint8Array): string | null {
  if (!egal(o, 0, [0, 0, 1, 0])) return non("ico : en-tête absent");
  const n = (o[4] ?? 0) | ((o[5] ?? 0) << 8);
  if (n === 0 || 6 + 16 * n > o.length) return non("ico : répertoire tronqué");
  const images: [number, number][] = [];
  for (let k = 0; k < n; k++) images.push([l32(o, 6 + 16 * k + 12), l32(o, 6 + 16 * k + 8)]);
  images.sort((a, b) => a[0] - b[0]);
  let attendu = 6 + 16 * n;
  for (const [offset, taille] of images) {
    if (offset !== attendu || taille < 8 || offset + taille > o.length) return non("ico : image hors répertoire ou octets inutilisés");
    const partie = o.subarray(offset, offset + taille);
    const raison = egal(partie, 0, PNG_SIGNATURE) ? png(partie) : [40, 108].includes(l32(partie, 0)) ? ok : non("ico : image ni PNG ni BMP");
    if (raison) return `ico : ${raison}`;
    attendu = offset + taille;
  }
  return attendu === o.length ? ok : non("ico : octets après la dernière image");
}

// null : aucune métadonnée texte ; sinon la règle qui a refusé (sans aucun contenu du fichier).
export function metadonneesInterdites(octets: Uint8Array, extension: string): string | null {
  switch (extension.toLowerCase().replace(/^\./, "")) {
    case "png":
      return png(octets);
    case "jpg":
    case "jpeg":
      return jpeg(octets);
    case "webp":
      return webp(octets);
    case "gif":
      return gif(octets);
    case "ico":
      return ico(octets);
    default:
      return non("type d'image non pris en charge");
  }
}

// Usage : metadonnees.ts <fichier> [lieu]. Code 0 propre, 1 refus (message sans contenu).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [fichier = "", lieu = "fichier"] = process.argv.slice(2);
  let raison: string | null;
  try {
    raison = metadonneesInterdites(readFileSync(fichier), extname(fichier));
  } catch {
    raison = "fichier illisible";
  }
  if (raison) {
    console.error(`métadonnées interdites, ${lieu} : les retirer`);
    process.exit(1);
  }
}
