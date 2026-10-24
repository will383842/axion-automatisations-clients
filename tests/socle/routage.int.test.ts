import { request } from "node:https";
import { describe, expect, it } from "vitest";

// Tests contre le socle lancé par ops/socle/lancer.sh (job socle-integration) et les services d'écho.
const DOMAINE_CONSOLE = process.env.DOMAINE_CONSOLE ?? "console.socle.test";
const DOMAINE_PORTAIL = process.env.DOMAINE_PORTAIL ?? "client.socle.test";
const DOMAINE_API = process.env.DOMAINE_API ?? "api.socle.test";
const DOMAINE_SSO = process.env.DOMAINE_SSO ?? "sso.socle.test";

// Appel HTTPS vers l'entrée du proxy avec le nom d'hôte demandé (certificat auto-signé du socle).
function appeler(nom: string): Promise<{ statut: number; corps: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: 8443, path: "/", method: "GET", headers: { Host: nom }, servername: nom, rejectUnauthorized: false },
      (res) => {
        let corps = "";
        res.on("data", (d: Buffer) => (corps += d.toString()));
        res.on("end", () => resolve({ statut: res.statusCode ?? 0, corps }));
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error(`délai dépassé pour ${nom}`)));
    req.end();
  });
}

// Les services démarrent sans sonde de santé : on laisse 30 s au proxy pour charger ses routes.
async function nomDuService(nom: string): Promise<string> {
  let derniere = "";
  for (let i = 0; i < 30; i++) {
    try {
      const r = await appeler(nom);
      const m = /^Name: (\S+)/m.exec(r.corps);
      if (r.statut === 200 && m?.[1]) return m[1];
      derniere = `statut ${r.statut}`;
    } catch (e) {
      derniere = String(e);
    }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  throw new Error(`${nom} : aucune réponse du service d'écho (${derniere})`);
}

describe("routage par nom d'hôte du proxy", () => {
  it("[A-081] le proxy sert console.socle.test et client.socle.test vers deux services distincts", async () => {
    const console_ = await nomDuService(DOMAINE_CONSOLE);
    const portail = await nomDuService(DOMAINE_PORTAIL);
    expect(console_).toBe("console");
    expect(portail).toBe("portail");
    expect(console_).not.toBe(portail);
  }, 70_000);
  it("[A-083] le proxy sert api.socle.test vers l'API", async () => {
    expect(await nomDuService(DOMAINE_API)).toBe("api");
  }, 40_000);
  it("[A-085] le proxy sert sso.socle.test vers Keycloak", async () => {
    expect(await nomDuService(DOMAINE_SSO)).toBe("keycloak");
  }, 40_000);
});
