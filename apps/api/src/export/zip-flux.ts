import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

// ZIP écrit en flux, sans bibliothèque ni disque : chaque entrée est compressée (deflate) morceau par morceau et suivie d'un descripteur de données
// (tailles et CRC connus à la fin). Pas de ZIP64 : une entrée ou un ZIP de 4 Gio ou plus est refusé (« zip_trop_gros »), jamais tronqué.
export interface EntreeZip {
  nom: string;
  contenu: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array;
}
const MAX32 = 0xffffffff;
const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTEUR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_FIN = 0x06054b50;
const DRAPEAUX = 0x0808; // bit 3 : descripteur de données ; bit 11 : noms en UTF-8
const invalide = (c: string) => new Error(c);

function nomValide(nom: string): string {
  const segments = nom.split("/");
  const mauvais = nom === "" || nom.length > 512 || nom.includes("\\") || [...nom].some((c) => c.codePointAt(0)! < 32) || segments.some((s) => s === "" || s === "." || s === "..");
  if (mauvais) throw invalide("nom_invalide");
  return nom;
}
function dos(date: Date): { heure: number; jour: number } {
  const a = Math.max(1980, date.getUTCFullYear());
  return { heure: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1), jour: ((a - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate() };
}
async function* morceaux(c: EntreeZip["contenu"]): AsyncGenerator<Uint8Array> {
  if (c instanceof Uint8Array) yield c;
  else yield* c;
}
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { if (n > MAX32) throw invalide("zip_trop_gros"); const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

export async function* ecrireZip(entrees: AsyncIterable<EntreeZip> | Iterable<EntreeZip>, date: Date): AsyncGenerator<Buffer> {
  const { heure, jour } = dos(date);
  const central: Buffer[] = [];
  const vus = new Set<string>();
  let position = 0;
  const sortir = (b: Buffer) => { position += b.length; return b; };
  for await (const e of entrees) {
    const nom = nomValide(e.nom);
    if (vus.has(nom)) throw invalide("nom_en_double");
    vus.add(nom);
    const octetsNom = Buffer.from(nom, "utf8");
    const debut = position;
    yield sortir(Buffer.concat([u32(SIG_LOCAL), u16(20), u16(DRAPEAUX), u16(8), u16(heure), u16(jour), u32(0), u32(0), u32(0), u16(octetsNom.length), u16(0), octetsNom]));
    let crc = 0;
    let brut = 0;
    let compresse = 0;
    for await (const m of morceaux(e.contenu)) {
      if (m.length === 0) continue;
      crc = crc32(m, crc);
      brut += m.length;
      const sortie = deflateRawSync(m, { finishFlush: 2 /* Z_SYNC_FLUSH */ });
      compresse += sortie.length;
      yield sortir(sortie);
    }
    // Fin du flux deflate : un bloc final vide.
    const fin = Buffer.from([0x03, 0x00]);
    compresse += fin.length;
    yield sortir(fin);
    yield sortir(Buffer.concat([u32(SIG_DESCRIPTEUR), u32(crc), u32(compresse), u32(brut)]));
    central.push(Buffer.concat([u32(SIG_CENTRAL), u16(20), u16(20), u16(DRAPEAUX), u16(8), u16(heure), u16(jour), u32(crc), u32(compresse), u32(brut), u16(octetsNom.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(debut), octetsNom]));
  }
  const repertoire = Buffer.concat(central);
  const debutRepertoire = position;
  yield sortir(repertoire);
  if (central.length > 0xffff) throw invalide("zip_trop_gros");
  yield sortir(Buffer.concat([u32(SIG_FIN), u16(0), u16(0), u16(central.length), u16(central.length), u32(repertoire.length), u32(debutRepertoire), u16(0)]));
}

// Relecture (vérification, essais) : lit le répertoire central et contrôle la somme CRC de chaque entrée ; refuse tout ce que l'écriture ne produit pas.
export function lireZip(zip: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.length);
  const fin = b.length - 22;
  if (fin < 0 || b.readUInt32LE(fin) !== SIG_FIN) throw invalide("zip_invalide");
  const total = b.readUInt16LE(fin + 10);
  let p = b.readUInt32LE(fin + 16);
  const sortie = new Map<string, Buffer>();
  for (let i = 0; i < total; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== SIG_CENTRAL) throw invalide("zip_invalide");
    const [methode, crc, taille, brut, ln, le, lc, debut] = [b.readUInt16LE(p + 10), b.readUInt32LE(p + 16), b.readUInt32LE(p + 20), b.readUInt32LE(p + 24), b.readUInt16LE(p + 28), b.readUInt16LE(p + 30), b.readUInt16LE(p + 32), b.readUInt32LE(p + 42)];
    const nom = nomValide(b.subarray(p + 46, p + 46 + ln).toString("utf8"));
    if (b.readUInt32LE(debut) !== SIG_LOCAL || methode !== 8) throw invalide("zip_invalide");
    const donnees = b.subarray(debut + 30 + b.readUInt16LE(debut + 26) + b.readUInt16LE(debut + 28), debut + 30 + b.readUInt16LE(debut + 26) + b.readUInt16LE(debut + 28) + taille);
    const clair = inflateRawSync(donnees);
    if (clair.length !== brut || crc32(clair) !== crc || sortie.has(nom)) throw invalide("zip_corrompu");
    sortie.set(nom, clair);
    p += 46 + ln + le + lc;
  }
  return sortie;
}
