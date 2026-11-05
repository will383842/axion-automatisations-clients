import { describe, expect, it } from "vitest";
import { creerRegistreJetons, creerStockageRemisesMemoire } from "./jetons.js";

const A = "11111111-1111-4111-8111-111111111111";
const EXEC = "22222222-2222-4222-8222-222222222222";
const INSTANCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const portee = { tenantId: A, instanceId: INSTANCE, connexionId: CONN, executionId: EXEC, portees: ["messagerie.lire"] } as const;

describe("jetons courts", () => {
  it("[C-014] un jeton court est lié à (client, exécution, portées) et rien d'autre", () => {
    const r = creerRegistreJetons();
    const { jeton } = r.emettre(portee, 60_000);
    expect(jeton).toMatch(/^cj1_[A-Za-z0-9_-]{43}$/);
    expect(r.lire(jeton)).toEqual(portee);
    expect(r.lire(`${jeton}x`)).toBeNull();
    expect(r.lire("cj1_inconnu")).toBeNull();
  });

  it("un jeton expire à la fin de sa durée et la durée est bornée", () => {
    let t = 1_000_000;
    const r = creerRegistreJetons({ maintenant: () => t });
    const { jeton } = r.emettre(portee, 60_000);
    t += 59_999;
    expect(r.lire(jeton)).not.toBeNull();
    t += 1;
    expect(r.lire(jeton)).toBeNull();
    expect(() => r.emettre(portee, 0)).toThrow();
    expect(() => r.emettre(portee, 3 * 3600_000)).toThrow();
  });

  it("un jeton est révocable, seul ou par exécution", () => {
    const r = creerRegistreJetons();
    const a = r.emettre(portee, 60_000).jeton;
    const b = r.emettre({ ...portee, portees: ["messagerie.envoyer"] }, 60_000).jeton;
    r.revoquer(a);
    expect(r.lire(a)).toBeNull();
    expect(r.lire(b)).not.toBeNull();
    expect(r.revoquerExecution(EXEC)).toBe(1);
    expect(r.lire(b)).toBeNull();
  });

  it("le registre ne garde que l'empreinte : le jeton n'apparaît pas dans son contenu", () => {
    const r = creerRegistreJetons();
    const { jeton } = r.emettre(portee, 60_000);
    expect(JSON.stringify([...r.empreintesPourEssai()])).not.toContain(jeton.slice(4));
    expect(String(r)).not.toContain(jeton);
  });

  it("[C-014] une remise n'est servie qu'une fois par (exécution, connexion), même après la fin de l'exécution", async () => {
    const r = creerRegistreJetons();
    expect(await r.reserver(EXEC, "c1")).toBe(true);
    expect(await r.reserver(EXEC, "c1")).toBe(false);
    expect(await r.reserver(EXEC, "c2")).toBe(true);
    r.revoquerExecution(EXEC);
    expect(await r.reserver(EXEC, "c1")).toBe(false);
    await r.liberer(EXEC, "c1");
    expect(await r.reserver(EXEC, "c1")).toBe(true);
  });

  it("[C-014] @isolation l'anti-rejeu survit à l'échéance et au redémarrage : il vit dans le registre durable", async () => {
    let t = 1_000_000;
    const durable = creerStockageRemisesMemoire();
    const r1 = creerRegistreJetons({ maintenant: () => t, remises: durable });
    expect(await r1.reserver(EXEC, CONN)).toBe(true);
    t += 10 * 3600_000; // bien au-delà de l'échéance (+60 s)
    expect(await r1.reserver(EXEC, CONN)).toBe(false);
    const r2 = creerRegistreJetons({ maintenant: () => t, remises: durable }); // redémarrage : nouveau registre, même stockage
    expect(await r2.reserver(EXEC, CONN)).toBe(false);
  });

  it("[C-014] @isolation un jeton ne vaut que pour son client, son instance, sa connexion et son exécution", () => {
    const r = creerRegistreJetons();
    const { jeton } = r.emettre(portee, 60_000);
    expect(r.verifier(jeton, { tenantId: A, instanceId: INSTANCE, connexionId: CONN, executionId: EXEC })).toEqual(portee);
    const autre = "99999999-9999-4999-8999-999999999999";
    for (const faux of [{ tenantId: autre }, { instanceId: autre }, { connexionId: autre }, { executionId: autre }]) {
      expect(r.verifier(jeton, { tenantId: A, instanceId: INSTANCE, connexionId: CONN, executionId: EXEC, ...faux })).toBeNull();
    }
  });
});
