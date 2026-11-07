import { describe, expect, it } from "vitest";
import { compterClients, etatClient } from "./client.js";

describe("état d'un client", () => {
  it("[A-027] l'état d'un client est le pire de ses instances", () => {
    expect(etatClient(["vert", "orange", "vert"])).toBe("orange");
    expect(etatClient(["vert", "rouge", "orange"])).toBe("rouge");
    expect(etatClient(["vert", "vert"])).toBe("vert");
  });
  it("[A-027] un client sans instance n'a pas d'état inventé", () => {
    expect(etatClient([])).toBe("inconnue");
  });
  it("[B-488] trois clients vert, orange, rouge comptés une fois chacun", () => {
    const c = compterClients({ "cli_lemoine": ["vert", "vert"], "cli_marceau": ["vert", "orange"], "cli_rivoire": ["rouge", "orange", "vert"] });
    expect(c).toEqual({ vert: 1, orange: 1, rouge: 1, inconnue: 0 });
  });
});
