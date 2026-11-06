import { describe, expect, it } from "vitest";
import { canalPoussees, publierPoussee } from "./poussees.js";

describe("poussées vers l'exécuteur", () => {
  it("[A-340] la console publie une pause sur le canal de la cellule, sans réglage", async () => {
    const publiees: [string, string][] = [];
    const valkey = { publish: async (c: string, m: string) => (publiees.push([c, m]), 1) };
    await publierPoussee(valkey, "auto-run-1", { type: "pause", instanceId: "inst-1" });
    expect(publiees).toEqual([["executeur:poussees:auto-run-1", JSON.stringify({ type: "pause", instanceId: "inst-1" })]]);
    expect(canalPoussees("auto-run-1")).toBe("executeur:poussees:auto-run-1");
  });

  it("[A-340] cellule, type ou instance invalides : rien n'est publié", async () => {
    const publiees: string[] = [];
    const valkey = { publish: async (c: string) => (publiees.push(c), 1) };
    await expect(publierPoussee(valkey, "a:b", { type: "pause", instanceId: "inst-1" })).rejects.toThrow();
    await expect(publierPoussee(valkey, "auto-run-1", { type: "x" as never, instanceId: "inst-1" })).rejects.toThrow();
    await expect(publierPoussee(valkey, "auto-run-1", { type: "pause", instanceId: "a b" })).rejects.toThrow();
    expect(publiees).toEqual([]);
  });
});
