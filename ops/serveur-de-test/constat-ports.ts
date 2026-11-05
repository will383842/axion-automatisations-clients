// Constat depuis l'EXTÉRIEUR (A-066) : quels ports TCP répondent ? Seul 443 doit répondre. À lancer d'une machine hors du serveur.
// Usage : node constat-ports.ts <hôte>   (code 0 conforme, 1 écart, 2 usage)
import { connect } from "node:net";
import { pathToFileURL } from "node:url";

const SERVICES_CONNUS = [1433, 2375, 2376, 3000, 3306, 5432, 6379, 6432, 8000, 8080, 8200, 8443, 9000, 9090, 27017];
export const PORTS_PAR_DEFAUT = [...new Set([...Array.from({ length: 1024 }, (_, i) => i + 1), ...SERVICES_CONNUS])];

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
  for (let i = 0; i < ports.length; i += 200) {
    const lot = ports.slice(i, i + 200);
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
  const ecarts = verdictPorts(await constaterPorts(hote, PORTS_PAR_DEFAUT, 1500));
  for (const e of ecarts) console.log(`ECART : ${e}`);
  console.log(ecarts.length === 0 ? "CONFORME : seul le port 443 répond" : `${ecarts.length} écart(s)`);
  process.exit(ecarts.length === 0 ? 0 : 1);
}
