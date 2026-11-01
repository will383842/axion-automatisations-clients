import { describe, expect, it } from "vitest";
import { adresseInterdite, analyserCible, evaluer, type Destination } from "./regles.ts";

const declarees: Destination[] = [{ hote: "api.exemple.test", port: 443 }];
const resoudreVers = (...ips: string[]) => async () => ips;

describe("règles de sortie", () => {
  it("[A-329] le mandataire refuse 127.0.0.1, 169.254.169.254 et une adresse privée", async () => {
    for (const ip of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "172.16.3.4", "192.168.1.9", "::1", "fe80::1", "fd00::7", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect(adresseInterdite(ip), ip).toBe(true);
      const v = await evaluer({ hote: ip, port: 443 }, [{ hote: ip, port: 443 }], { resoudre: resoudreVers(ip) });
      expect(v, ip).toEqual({ autorise: false, raison: "adresse_interdite" });
    }
    expect(adresseInterdite("93.184.216.34")).toBe(false);
  });

  it("[A-329] un nom qui se résout vers une adresse privée est refusé (rebinding DNS)", async () => {
    expect(await evaluer({ hote: "api.exemple.test", port: 443 }, declarees, { resoudre: resoudreVers("10.1.2.3") })).toEqual({ autorise: false, raison: "adresse_interdite" });
    // Une seule adresse interdite parmi plusieurs suffit au refus.
    expect(await evaluer({ hote: "api.exemple.test", port: 443 }, declarees, { resoudre: resoudreVers("93.184.216.34", "169.254.169.254") })).toEqual({ autorise: false, raison: "adresse_interdite" });
  });

  it("[A-329] un hôte non déclaré, ou un port non déclaré, est refusé sans résolution", async () => {
    const resoudre = async () => {
      throw new Error("ne doit pas être appelé");
    };
    expect(await evaluer({ hote: "autre.exemple.test", port: 443 }, declarees, { resoudre })).toEqual({ autorise: false, raison: "non_declare" });
    expect(await evaluer({ hote: "api.exemple.test", port: 22 }, declarees, { resoudre })).toEqual({ autorise: false, raison: "non_declare" });
  });

  it("[A-329] un hôte déclaré qui se résout vers une adresse publique est autorisé, avec l'adresse résolue par le mandataire", async () => {
    expect(await evaluer({ hote: "API.exemple.test.", port: 443 }, declarees, { resoudre: resoudreVers("93.184.216.34") })).toEqual({ autorise: true, adresse: "93.184.216.34" });
  });

  it("[A-329] la liste du socle de test n'ouvre les adresses privées qu'en NODE_ENV=test", async () => {
    const dest = { hote: "api.exemple.test", port: 443 };
    const opts = { resoudre: resoudreVers("10.1.2.3"), exceptions: ["10.1.2.3"] };
    expect(await evaluer(dest, declarees, { ...opts, env: "test" })).toEqual({ autorise: true, adresse: "10.1.2.3" });
    expect(await evaluer(dest, declarees, { ...opts, env: "production" })).toEqual({ autorise: false, raison: "adresse_interdite" });
  });

  it("[A-329] analyse de la cible CONNECT : IPv6 entre crochets, port obligatoire, rien d'étrange", () => {
    expect(analyserCible("api.exemple.test:443")).toEqual({ hote: "api.exemple.test", port: 443 });
    expect(analyserCible("[::1]:443")).toEqual({ hote: "::1", port: 443 });
    for (const mauvais of ["api.exemple.test", "api.exemple.test:0", "api.exemple.test:70000", "a b:443", "http://x:443", ":443", "[::1:443"]) expect(analyserCible(mauvais), mauvais).toBeUndefined();
  });
});
