import { execFileSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { request } from "node:https";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../scripts/garde-compose.ts";

// Porte du lot 1-A (T1A-19, partie A) : essais en boîte noire contre le socle lancé par ops/socle/lancer.sh (job socle-integration).
// Réseau : aucun service interne joignable hors du réseau « interne », et rien ne sort du réseau « interne ».
// Les sondes sont des conteneurs jetables d'une image déjà tirée par le socle (Valkey : bash et timeout), sans aucun secret.
const PROJET = "socle";
const racine = (chemin: string) => fileURLToPath(new URL(`../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", `label=com.docker.compose.project=${PROJET}`, "--filter", `label=com.docker.compose.service=${service}`);
const IMAGE_SONDE = (lireYaml(readFileSync(racine("ops/socle/compose.valkey.yml"), "utf8")) as unknown as { services: { valkey: { image: string } } }).services.valkey.image;

// Le job ne lance Vitest qu'avec le rapport JSON : un échec n'y est pas lisible, on l'écrit sur la sortie d'erreur (jamais de valeur secrète dans ces messages).
afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") writeSync(2, `ECHEC ${ctx.task.name}\n${(ctx.task.result.errors ?? []).map((e) => e.message).join("\n")}\n`);
});

interface Cible { nom: string; port: number }
// Services internes et leurs ports d'écoute connus (images du socle) ; les adresses sont lues sur le réseau interne au lancement.
const INTERNES: { service: string; ports: number[] }[] = [
  { service: "postgres", ports: [5432] },
  { service: "pgbouncer", ports: [6432] },
  { service: "valkey", ports: [6379] },
  { service: "openbao", ports: [8200, 8201] },
  { service: "stockage", ports: [8333, 9333, 8888, 8080] },
  { service: "keycloak", ports: [8080, 9000] },
  { service: "greenmail", ports: [3993, 3465] },
  { service: "sftp-essai", ports: [22] },
];

// Sonde TCP lancée DANS un conteneur jetable du réseau donné : une ligne « OUVERT » ou « FERME » par cible, rien d'autre.
function sonder(reseau: string, cibles: Cible[], dns: string[] = []): Map<string, "OUVERT" | "FERME"> {
  const lignes = [
    ...cibles.map((c) => `if timeout 3 bash -c 'exec 3<>/dev/tcp/${c.nom}/${c.port}' 2>/dev/null; then echo "OUVERT ${c.nom}:${c.port}"; else echo "FERME ${c.nom}:${c.port}"; fi`),
    ...dns.map((n) => `if timeout 3 getent hosts ${n} >/dev/null 2>&1; then echo "OUVERT dns:${n}"; else echo "FERME dns:${n}"; fi`),
  ];
  const sortie = docker("run", "--rm", "--network", reseau, "--entrypoint", "bash", IMAGE_SONDE, "-c", lignes.join("\n"));
  const etat = new Map<string, "OUVERT" | "FERME">();
  for (const l of sortie.split("\n")) {
    const [e, cle] = l.trim().split(" ");
    if ((e === "OUVERT" || e === "FERME") && cle) etat.set(cle, e);
  }
  return etat;
}
const ouverts = (etat: Map<string, string>) => [...etat].filter(([, e]) => e === "OUVERT").map(([c]) => c).sort();

let adresses: Map<string, string>;
beforeAll(() => {
  adresses = new Map(INTERNES.map(({ service }) => [service, docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', conteneur(service))]));
  for (const [s, ip] of adresses) if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`adresse interne illisible pour ${s}`);
}, 60_000);

describe("audit 1-A · réseau : rien d'interne hors du réseau interne", () => {
  it("[A-066] à l'exécution, seul le proxy publie un port (sur 127.0.0.1), et aucun conteneur n'est à la fois sur « entree » et « interne »", () => {
    expect(docker("network", "inspect", "-f", "{{.Internal}}", "socle_interne")).toBe("true");
    const ids = docker("ps", "-q", "--filter", `label=com.docker.compose.project=${PROJET}`).split("\n").filter(Boolean);
    expect(ids.length).toBeGreaterThan(5);
    const publies: string[] = [];
    const ponts: string[] = [];
    for (const id of ids) {
      const service = docker("inspect", "-f", '{{index .Config.Labels "com.docker.compose.service"}}', id);
      const ports = JSON.parse(docker("inspect", "-f", "{{json .NetworkSettings.Ports}}", id) || "{}") as Record<string, { HostIp: string; HostPort: string }[] | null>;
      for (const [interne, liaisons] of Object.entries(ports ?? {})) for (const l of liaisons ?? []) publies.push(`${service} ${l.HostIp}:${l.HostPort}->${interne}`);
      const reseaux = Object.keys(JSON.parse(docker("inspect", "-f", "{{json .NetworkSettings.Networks}}", id)) as Record<string, unknown>);
      if (reseaux.includes("socle_interne") && reseaux.some((r) => r !== "socle_interne")) ponts.push(`${service} : ${reseaux.sort().join(", ")}`);
    }
    expect(publies).toEqual(["traefik 127.0.0.1:8443->8443/tcp"]);
    expect(ponts).toEqual([]);
  }, 60_000);

  it("[A-066] depuis le réseau « entree », aucun service interne ne répond, ni par son nom ni par son adresse (témoin : le proxy répond)", () => {
    const cibles: Cible[] = [{ nom: "traefik", port: 8443 }];
    for (const { service, ports } of INTERNES) for (const port of ports) cibles.push({ nom: service, port }, { nom: adresses.get(service) ?? "", port });
    const etat = sonder("socle_entree", cibles);
    expect(etat.get("traefik:8443"), "témoin : la sonde joint le proxy").toBe("OUVERT");
    expect(etat.size).toBe(cibles.length);
    expect(ouverts(etat)).toEqual(["traefik:8443"]);
  }, 120_000);

  it("[C-533] depuis le réseau « interne », rien ne sort : ni adresse publique, ni résolution d'un nom extérieur (témoin : PostgreSQL répond)", () => {
    const etat = sonder(
      "socle_interne",
      [{ nom: "postgres", port: 5432 }, { nom: "1.1.1.1", port: 443 }, { nom: "8.8.8.8", port: 53 }, { nom: "140.82.112.3", port: 443 }],
      ["github.com", "example.com"],
    );
    expect(etat.get("postgres:5432"), "témoin : la sonde joint PostgreSQL").toBe("OUVERT");
    expect(ouverts(etat)).toEqual(["postgres:5432"]);
  }, 120_000);

  it("[C-533] depuis le réseau « interne », l'hôte n'est pas joignable par la passerelle du pont (proxy publié, SSH)", () => {
    const passerelle = docker("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", "socle_interne");
    // Sans passerelle déclarée (réseau internal), on prend la première adresse du sous-réseau, celle que Docker donne au pont.
    const sousReseau = docker("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", "socle_interne");
    const pont = passerelle || sousReseau.replace(/\.0\/\d+$/, ".1");
    expect(pont).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const etat = sonder("socle_interne", [{ nom: "postgres", port: 5432 }, { nom: pont, port: 8443 }, { nom: pont, port: 22 }]);
    expect(etat.get("postgres:5432")).toBe("OUVERT");
    expect(ouverts(etat)).toEqual(["postgres:5432"]);
  }, 120_000);

  it("[A-066] depuis l'hôte, aucun port interne n'écoute sur 127.0.0.1 (témoin : 8443 répond)", async () => {
    const essayer = (port: number) =>
      new Promise<boolean>((ok) => {
        const s = connect({ host: "127.0.0.1", port });
        s.setTimeout(2000, () => (s.destroy(), ok(false)));
        s.on("connect", () => (s.destroy(), ok(true)));
        s.on("error", () => ok(false));
      });
    expect(await essayer(8443)).toBe(true);
    const ports = [...new Set(INTERNES.flatMap((s) => s.ports))].filter((p) => p !== 8443 && p !== 22);
    const repondent: number[] = [];
    for (const p of ports) if (await essayer(p)) repondent.push(p);
    expect(repondent).toEqual([]);
  }, 60_000);

  it("[A-066] le proxy ne route aucun nom inconnu ni aucun nom de service interne : même 404, même corps", async () => {
    const appeler = (nom: string) =>
      new Promise<{ statut: number; corps: string }>((ok, ko) => {
        const req = request({ host: "127.0.0.1", port: 8443, path: "/v1/sys/health", method: "GET", headers: { Host: nom }, servername: "inconnu.socle.test", rejectUnauthorized: false }, (res) => {
          let corps = "";
          res.on("data", (d: Buffer) => (corps += d.toString()));
          res.on("end", () => ok({ statut: res.statusCode ?? 0, corps }));
        });
        req.on("error", ko);
        req.setTimeout(5000, () => req.destroy(new Error(`délai dépassé pour ${nom}`)));
        req.end();
      });
    const noms = ["inconnu.socle.test", "postgres", "openbao", "openbao.socle.test", "valkey", "stockage", "stockage.socle.test", "pgbouncer", "127.0.0.1", "console.socle.test.exemple.fr"];
    const reponses = await Promise.all(noms.map(appeler));
    const reference = reponses[0];
    expect(reference?.statut).toBe(404);
    for (const [i, r] of reponses.entries()) expect(r, noms[i]).toEqual(reference);
  }, 60_000);
});
