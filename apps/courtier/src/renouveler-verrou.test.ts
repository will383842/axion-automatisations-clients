import { describe, expect, it } from "vitest";
import { creerVerrouMemoire, creerVerrouValkey, type ClientValkey } from "./verrou.js";

describe("verrou par connexion", () => {
  it("[A-336] un seul titulaire à la fois, et la libération vérifie le jeton de verrou", async () => {
    const t = 0;
    const v = creerVerrouMemoire(() => t);
    const a = await v.prendre("conn-1", 1000);
    expect(a).not.toBeNull();
    expect(await v.prendre("conn-1", 1000)).toBeNull();
    await v.liberer("conn-1", "jeton-d-un-autre");
    expect(await v.prendre("conn-1", 1000)).toBeNull(); // le bail de A tient toujours
    await v.liberer("conn-1", a as string);
    expect(await v.prendre("conn-1", 1000)).not.toBeNull();
  });

  it("[A-336] un bail expiré est repris, et l'ancien titulaire ne peut ni prolonger ni libérer le nouveau", async () => {
    let t = 0;
    const v = creerVerrouMemoire(() => t);
    const a = (await v.prendre("conn-1", 1000)) as string;
    t = 1500;
    const b = (await v.prendre("conn-1", 1000)) as string;
    expect(b).not.toBeNull();
    expect(await v.prolonger("conn-1", a, 1000)).toBe(false);
    await v.liberer("conn-1", a);
    expect(await v.prendre("conn-1", 1000)).toBeNull();
    expect(await v.prolonger("conn-1", b, 1000)).toBe(true);
  });

  it("[A-336] l'adaptateur Valkey prend avec NX + PX et compare le jeton avant de prolonger ou libérer", async () => {
    const magasin = new Map<string, string>();
    const appels: string[] = [];
    const client: ClientValkey = {
      set: async (cle, valeur, ...args) => { appels.push(args.join(" ")); if (args.includes("NX") && magasin.has(cle)) return null; magasin.set(cle, valeur); return "OK"; },
      eval: async (script, _n, cle, jeton) => {
        appels.push(script.includes("pexpire") ? "prolonger" : "liberer");
        if (magasin.get(cle as string) !== jeton) return 0;
        if (script.includes("del")) magasin.delete(cle as string);
        return 1;
      },
    };
    const v = creerVerrouValkey(client);
    const a = (await v.prendre("conn-1", 5000)) as string;
    expect(a).toBeTruthy();
    expect(appels[0]).toBe("PX 5000 NX");
    expect(await v.prendre("conn-1", 5000)).toBeNull();
    await v.liberer("conn-1", "autre");
    expect(magasin.size).toBe(1);
    expect(await v.prolonger("conn-1", a, 5000)).toBe(true);
    await v.liberer("conn-1", a);
    expect(magasin.size).toBe(0);
  });
});
