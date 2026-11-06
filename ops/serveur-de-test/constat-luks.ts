// Constat des disques chiffrés (A-196, A-242). Lit la sortie de « lsblk --json --output NAME,TYPE,MOUNTPOINTS » : un montage n'est dit chiffré
// que si TOUT ce qui le porte repose sur une couche « crypt » (LUKS). Un montage absent, ou en partie en clair, est non chiffré.
// Usage sur le serveur : node constat-luks.ts <montage>...   (code 0 si tout est chiffré, 1 sinon, 2 si la lecture échoue)
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

interface Noeud { type?: string; mountpoints?: (string | null)[]; mountpoint?: string | null; children?: Noeud[] }

export function constaterLuks(sortieLsblk: string, montages: string[]): { montage: string; chiffre: boolean }[] {
  if (montages.length === 0) throw new Error("aucun montage à constater");
  const doc = JSON.parse(sortieLsblk) as { blockdevices?: Noeud[] };
  if (!Array.isArray(doc.blockdevices)) throw new Error("sortie lsblk illisible");
  const vus = new Map<string, boolean[]>();
  const parcourir = (n: Noeud, sousCrypt: boolean) => {
    const crypt = sousCrypt || n.type === "crypt";
    for (const m of [...(n.mountpoints ?? []), n.mountpoint]) if (m) vus.set(m, [...(vus.get(m) ?? []), crypt]);
    for (const e of n.children ?? []) parcourir(e, crypt);
  };
  for (const n of doc.blockdevices) parcourir(n, false);
  return montages.map((montage) => {
    const etats = vus.get(montage) ?? [];
    return { montage, chiffre: etats.length > 0 && etats.every(Boolean) };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const res = constaterLuks(execFileSync("lsblk", ["--json", "--output", "NAME,TYPE,MOUNTPOINTS"], { encoding: "utf8" }), process.argv.slice(2));
    for (const r of res) console.log(`${r.chiffre ? "CHIFFRE" : "NON CHIFFRE"} ${r.montage}`);
    process.exit(res.every((r) => r.chiffre) ? 0 : 1);
  } catch (e) {
    console.error(`constat impossible : ${e instanceof Error ? e.message : "erreur"}`);
    process.exit(2);
  }
}
