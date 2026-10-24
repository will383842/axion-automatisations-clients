import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { metadonneesInterdites } from "./metadonnees.js";

// Nom inventé DES TESTS : il n'est dans aucune vraie liste.
const NOM = "Quincaillerie Zéphyrine Ostrowska";
const racine = fileURLToPath(new URL("../..", import.meta.url));
const dossier = mkdtempSync(join(tmpdir(), "garde-meta-"));
afterAll(() => rmSync(dossier, { recursive: true, force: true }));

const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const le32 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const bloc = (type: string, donnees: Buffer) => Buffer.concat([u32(donnees.length), Buffer.from(type, "latin1"), donnees, u32(0)]);
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = bloc("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
const png = (...blocs: Buffer[]) => Buffer.concat([SIGNATURE, ihdr, ...blocs, bloc("IDAT", Buffer.from([0x78, 0x9c, 1, 2])), bloc("IEND", Buffer.alloc(0))]);
const texte = Buffer.from(`Commentaire\0${NOM}`, "utf8");

const seg = (marqueur: number, donnees: Buffer) => Buffer.concat([Buffer.from([0xff, marqueur]), Buffer.from([(donnees.length + 2) >> 8, (donnees.length + 2) & 255]), donnees]);
const jfif = seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
const jpeg = (...segs: Buffer[]) => Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, ...segs, seg(0xdb, Buffer.alloc(65)), seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])), seg(0xc4, Buffer.alloc(17)), seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34]), Buffer.from([0xff, 0xd9])]);

const riff = (...chunks: Buffer[]) => {
  const corps = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  return Buffer.concat([Buffer.from("RIFF"), le32(corps.length), corps]);
};
const chunkWebp = (type: string, d: Buffer) => Buffer.concat([Buffer.from(type, "latin1"), le32(d.length), d, d.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
const vp8x = chunkWebp("VP8X", Buffer.alloc(10));
const vp8 = chunkWebp("VP8 ", Buffer.alloc(10));

const lsd = Buffer.from([1, 0, 1, 0, 0x00, 0, 0]);
const image = Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0x00])]);
const gif = (...ext: Buffer[]) => Buffer.concat([Buffer.from("GIF89a"), lsd, ...ext, image, Buffer.from(";")]);
const gce = Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]);
const netscape = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from("NETSCAPE2.0"), Buffer.from([3, 1, 0, 0, 0])]);

describe("metadonnees : liste fermée de blocs", () => {
  it("[C-611] metadonnees accepte un png sans métadonnée", () => {
    expect(metadonneesInterdites(png(), "png")).toBeNull();
    expect(metadonneesInterdites(png(bloc("gAMA", u32(45455)), bloc("pHYs", Buffer.alloc(9))), "png")).toBeNull();
  });
  it("[C-611] metadonnees refuse un png avec iTXt / tEXt / zTXt contenant le nom accentué", () => {
    for (const type of ["iTXt", "tEXt", "zTXt", "eXIf", "iCCP", "sPLT", "prVt"]) expect(metadonneesInterdites(png(bloc(type, texte)), "png")).not.toBeNull();
  });
  it("[C-611] metadonnees refuse un jpeg avec EXIF, XMP ou COM", () => {
    expect(metadonneesInterdites(jpeg(), "jpg")).toBeNull();
    for (const m of [0xe1, 0xe2, 0xed, 0xfe]) expect(metadonneesInterdites(jpeg(seg(m, texte)), "jpeg")).not.toBeNull();
  });
  it("[C-611] metadonnees refuse un webp avec EXIF ou XMP", () => {
    expect(metadonneesInterdites(riff(vp8x, vp8), "webp")).toBeNull();
    expect(metadonneesInterdites(riff(vp8x, vp8, chunkWebp("EXIF", texte)), "webp")).not.toBeNull();
    expect(metadonneesInterdites(riff(vp8x, vp8, chunkWebp("XMP ", texte)), "webp")).not.toBeNull();
  });
  it("[C-611] metadonnees refuse un gif avec commentaire", () => {
    expect(metadonneesInterdites(gif(gce), "gif")).toBeNull();
    const commentaire = Buffer.concat([Buffer.from([0x21, 0xfe, texte.length]), texte, Buffer.from([0])]);
    expect(metadonneesInterdites(gif(commentaire), "gif")).not.toBeNull();
  });
  it("[C-611] metadonnees refuse un gif avec extension texte brut (0x01) ou une extension d'application autre que NETSCAPE2.0 exacte", () => {
    expect(metadonneesInterdites(gif(gce, netscape), "gif")).toBeNull();
    const brut = Buffer.concat([Buffer.from([0x21, 0x01, 12, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, texte.length]), texte, Buffer.from([0])]);
    expect(metadonneesInterdites(gif(brut), "gif")).not.toBeNull();
    const autre = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from("XMP DataXMP"), Buffer.from([texte.length]), texte, Buffer.from([0])]);
    expect(metadonneesInterdites(gif(autre), "gif")).not.toBeNull();
    const longue = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from("NETSCAPE2.0"), Buffer.from([texte.length]), texte, Buffer.from([0])]);
    expect(metadonneesInterdites(gif(longue), "gif")).not.toBeNull();
  });
  it("[C-611] metadonnees refuse des octets après IEND, EOI, la fin du RIFF et le « ; » du GIF", () => {
    const suite = Buffer.from(NOM);
    expect(metadonneesInterdites(Buffer.concat([png(), suite]), "png")).not.toBeNull();
    expect(metadonneesInterdites(Buffer.concat([jpeg(), suite]), "jpg")).not.toBeNull();
    expect(metadonneesInterdites(Buffer.concat([riff(vp8x, vp8), suite]), "webp")).not.toBeNull();
    expect(metadonneesInterdites(Buffer.concat([gif(), suite]), "gif")).not.toBeNull();
  });
  it("[C-611] metadonnees refuse un fichier tronqué ou d'un autre type que son extension", () => {
    expect(metadonneesInterdites(png().subarray(0, 30), "png")).not.toBeNull();
    expect(metadonneesInterdites(Buffer.from("%PDF-1.4"), "png")).not.toBeNull();
    expect(metadonneesInterdites(png(), "pdf")).not.toBeNull();
  });
  it("[C-611] metadonnees refuse un APP0 JFIF dont la longueur ne correspond pas à la vignette", () => {
    const base = "JFIF\0\x01\x01\0\0\x01\0\x01";
    const avec = (fin: string, extra = "") => Buffer.from(`${base}${fin}${extra}`, "latin1");
    const j = (app0: Buffer) => Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, app0), seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0xff, 0xd9])]);
    expect(metadonneesInterdites(j(avec("\0\0")), "jpg")).toBeNull();
    expect(metadonneesInterdites(j(avec("\0\0", NOM)), "jpg")).not.toBeNull();
    expect(metadonneesInterdites(j(avec("\x01\x01", "\0\0\0")), "jpg")).toBeNull();
    expect(metadonneesInterdites(j(avec("\x01\x01", `\0\0\0${NOM}`)), "jpg")).not.toBeNull();
  });
  it("[C-611] metadonnees refuse un BMP V5 (profil ICC possible) dans un ico", () => {
    const bmp = Buffer.concat([Buffer.from([124, 0, 0, 0]), Buffer.alloc(120)]);
    const ent = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0]), le32(bmp.length), le32(22)]);
    expect(metadonneesInterdites(Buffer.concat([ent, bmp]), "ico")).not.toBeNull();
  });
  it("[C-611] metadonnees contrôle chaque image d'un ico", () => {
    const image1 = png();
    const entete = (n: number, ...tailles: Buffer[]) => {
      let offset = 6 + 16 * n;
      const entrees = tailles.map((t) => {
        const e = Buffer.concat([Buffer.from([1, 1, 0, 0, 1, 0, 32, 0]), le32(t.length), le32(offset)]);
        offset += t.length;
        return e;
      });
      return Buffer.concat([Buffer.from([0, 0, 1, 0, n, 0]), ...entrees]);
    };
    expect(metadonneesInterdites(Buffer.concat([entete(1, image1), image1]), "ico")).toBeNull();
    const sale = png(bloc("tEXt", texte));
    expect(metadonneesInterdites(Buffer.concat([entete(1, sale), sale]), "ico")).not.toBeNull();
    expect(metadonneesInterdites(Buffer.concat([entete(1, image1), image1, Buffer.from(NOM)]), "ico")).not.toBeNull();
  });
  it("[C-531] la sortie de metadonnees ne contient jamais le contenu des métadonnées", () => {
    const f = join(dossier, "x.png");
    writeFileSync(f, png(bloc("iTXt", texte)));
    const r = spawnSync("node", [join(racine, "scripts/garde-noms/metadonnees.ts"), f, "fichier 3"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    expect(r.status).toBe(1);
    const s = `${r.stdout}${r.stderr}`;
    expect(s).toContain("métadonnées interdites, fichier 3 : les retirer");
    for (const m of ["quincaillerie", "ostrowska", "commentaire"]) expect(s.toLowerCase()).not.toContain(m);
    writeFileSync(f, png());
    expect(spawnSync("node", [join(racine, "scripts/garde-noms/metadonnees.ts"), f], { env: { PATH: process.env["PATH"] ?? "" } }).status).toBe(0);
  });
});

describe("garde des noms : dépendances du code de garde (N1)", () => {
  it("[C-611] chercher.ts, normaliser.ts et metadonnees.ts n'importent que node:* et des fichiers de leur dossier", () => {
    for (const nom of ["chercher.ts", "normaliser.ts", "metadonnees.ts"]) {
      const source = readFileSync(join(racine, "scripts/garde-noms", nom), "utf8");
      const imports = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
      for (const i of imports) expect(i, `${nom} importe ${i}`).toMatch(/^(node:[a-z:_/]+|\.\/[^/]+\.ts)$/);
      expect(source).not.toMatch(/\bimport\s*\(\s*[^"'\s)]/); // pas d'import dynamique calculé
    }
  });
});
