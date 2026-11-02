import { describe, expect, it } from "vitest";
import { creerRegistreJetons } from "./jetons.js";

const A = "11111111-1111-4111-8111-111111111111";
const EXEC = "22222222-2222-4222-8222-222222222222";
const portee = { tenantId: A, executionId: EXEC, portees: ["messagerie.lire"] } as const;

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

  it("une remise n'est servie qu'une fois par (exécution, connexion), même après la fin de l'exécution", () => {
    const r = creerRegistreJetons();
    expect(r.reserver(EXEC, "c1", 60_000)).toBe(true);
    expect(r.reserver(EXEC, "c1", 60_000)).toBe(false);
    expect(r.reserver(EXEC, "c2", 60_000)).toBe(true);
    r.revoquerExecution(EXEC);
    expect(r.reserver(EXEC, "c1", 60_000)).toBe(false);
  });
});
