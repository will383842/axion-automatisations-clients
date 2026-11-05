// Constat depuis l'EXTÉRIEUR (A-066) : quels ports TCP répondent ? Seul 443 doit répondre. À lancer d'une machine hors du serveur.
// Usage : node constat-ports.ts <hôte>   (code 0 conforme, 1 écart, 2 usage)
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";

// Tous les ports TCP : une plage ouverte au-dessus de 1024 ne doit pas passer inaperçue.
export const PORTS_PAR_DEFAUT = Array.from({ length: 65535 }, (_, i) => i + 1);

// Toutes les adresses de l'hôte (IPv4 ET IPv6) : un pare-feu fermé en IPv4 et ouvert en IPv6 doit être vu.
export async function adressesDe(hote: string): Promise<string[]> {
  const res = await lookup(hote, { all: true });
  const adresses = [...new Set(res.map((a) => a.address))];
  if (adresses.length === 0) throw new Error("hôte sans adresse");
  return adresses;
}

const ouvert = (hote: string, port: number, delaiMs: number) =>
  new Promise<boolean>((fin) => {
    const s = connect({ host: hote, port });
    const clore = (v: boolean) => { s.destroy(); fin(v); };
    s.setTimeout(delaiMs, () => clore(false));
    s.once("connect", () => clore(true));
    s.once("error", () => clore(false));
  });

export async function constaterPorts(hote: string, ports: number[], delaiMs: number): Promise<number[]> {
  const ouverts: number[] = [];
  for (let i = 0; i < ports.length; i += 1000) {
    const lot = ports.slice(i, i + 1000);
    const res = await Promise.all(lot.map((p) => ouvert(hote, p, delaiMs)));
    lot.forEach((p, k) => { if (res[k]) ouverts.push(p); });
  }
  return ouverts.sort((a, b) => a - b);
}

export function verdictPorts(ouverts: number[]): string[] {
  const ecarts = ouverts.filter((p) => p !== 443).map((p) => `le port ${p} répond depuis l'extérieur`);
  if (!ouverts.includes(443)) ecarts.push("le port 443 ne répond pas");
  return ecarts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hote = process.argv[2];
  if (!hote) { console.error("usage : node constat-ports.ts <hôte>"); process.exit(2); }
  let adresses: string[];
  try { adresses = await adressesDe(hote); } catch { console.error("hôte introuvable : aucun constat"); process.exit(2); }
  const ecarts: string[] = [];
  for (const a of adresses) {
    const famille = a.includes(":") ? "IPv6" : "IPv4";
    for (const e of verdictPorts(await constaterPorts(a, PORTS_PAR_DEFAUT, 1500))) ecarts.push(`${famille} : ${e}`);
  }
  for (const e of ecarts) console.log(`ECART : ${e}`);
  console.log(ecarts.length === 0 ? "CONFORME : seul le port 443 répond" : `${ecarts.length} écart(s)`);
  process.exit(ecarts.length === 0 ? 0 : 1);
}
