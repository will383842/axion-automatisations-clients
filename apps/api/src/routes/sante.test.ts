import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { construireServeur } from "../serveur.js";

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

describe("route /sante", () => {
  it("[C-397] essai : GET /sante répond 200 et la version", async () => {
    const serveur = construireServeur();
    const reponse = await serveur.inject({ method: "GET", url: "/sante" });
    expect(reponse.statusCode).toBe(200);
    expect(reponse.json()).toEqual({ etat: "ok", version });
    await serveur.close();
  });
});
