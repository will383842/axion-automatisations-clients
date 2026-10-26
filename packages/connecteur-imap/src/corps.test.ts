import { describe, expect, it } from "vitest";
import { choisirPartieTexte, decoderCorps } from "./corps.ts";

describe("corps du message", () => {
  it("[A-389] le quoted-printable et le base64 sont décodés avec leur jeu de caractères", () => {
    expect(decoderCorps(Buffer.from("Caf=C3=A9 =\r\nouvert"), "quoted-printable", "utf-8")).toBe("Café ouvert");
    expect(decoderCorps(Buffer.from("Q2Fm6Q==", "utf8"), "base64", "iso-8859-1")).toBe("Café");
    expect(decoderCorps(Buffer.from("Bonjour"), "7bit", "us-ascii")).toBe("Bonjour");
  });
  it("[A-389] avec plusieurs parties, on lit la première partie text/plain, pas les frontières MIME", () => {
    const structure = {
      type: "multipart/alternative",
      childNodes: [
        { part: "1", type: "text/plain", encoding: "quoted-printable", parameters: { charset: "utf-8" } },
        { part: "2", type: "text/html", encoding: "7bit" },
      ],
    };
    expect(choisirPartieTexte(structure)).toEqual({ numero: "1", encodage: "quoted-printable", charset: "utf-8" });
    expect(choisirPartieTexte({ type: "text/plain", encoding: "7bit" })).toEqual({ numero: "1", encodage: "7bit", charset: "utf-8" });
    expect(choisirPartieTexte({ type: "multipart/mixed", childNodes: [{ part: "1", type: "image/png" }] })).toBeUndefined();
  });
});
