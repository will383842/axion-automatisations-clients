import { describe, expect, it } from "vitest";
import { statutVersHub } from "./statut.ts";

describe("statut du client vers le Hub", () => {
  it("[C-324] en_signature part au Hub comme prospect (jamais envoyé tel quel)", () => {
    expect(statutVersHub("en_signature")).toBe("prospect");
  });
  it("[C-324] prospect, client et ancien_client sont traduits dans le vocabulaire gelé de C1", () => {
    expect([statutVersHub("prospect"), statutVersHub("client"), statutVersHub("ancien_client")]).toEqual(["prospect", "client_actif", "ancien_client"]);
  });
  it("[C-324] le passage à client ne déclenche pas le provisionnement (un seul déclencheur : contrat_signe)", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("./statut.ts", import.meta.url), "utf8")).not.toMatch(/declencherProvisionnement/);
  });
});
