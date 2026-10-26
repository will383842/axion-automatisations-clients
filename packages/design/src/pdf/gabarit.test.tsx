/** @jsxRuntime automatic @jsxImportSource react */
import { Text } from "@react-pdf/renderer";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { EnTete } from "./EnTete.tsx";
import { Gabarit } from "./Gabarit.tsx";
import { Pied } from "./Pied.tsx";

describe("gabarit de PDF (@react-pdf/renderer)", () => {
  it("[C-597] le PDF généré embarque ses polices (aucune police de repli)", async () => {
    const tampon = await renderToBuffer(
      <Gabarit titre="Compte rendu de la semaine">
        <EnTete titre="Compte rendu de la semaine" client="Boulangerie Rivoire" />
        <Text>Douze e-mails triés, aucun perdu.</Text>
        <Pied />
      </Gabarit>,
    );
    const brut = tampon.toString("latin1");
    expect(brut.startsWith("%PDF")).toBe(true);
    expect(brut).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Manrope/);
    expect(brut).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Fraunces/);
    expect(brut).not.toMatch(/\/BaseFont\s*\/(Helvetica|Times|Courier)/);
  });
});
