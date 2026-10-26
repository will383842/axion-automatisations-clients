/** @jsxRuntime automatic @jsxImportSource react */
import { render } from "@react-email/components";
import { describe, expect, it } from "vitest";
import { aplatir, couleursDe, jetons } from "../jetons.ts";
import { Bouton } from "./Bouton.tsx";
import { Gabarit } from "./Gabarit.tsx";
import { Pied } from "./Pied.tsx";

const message = (
  <Gabarit titre="Une réponse est prête à relire" apercu="Lemoine Rénovation : une réponse attend votre geste.">
    <p>Bonjour Claire, une réponse est prête.</p>
    <Bouton href="https://portail.exemple.fr/arelire">Relire la réponse</Bouton>
    <Pied />
  </Gabarit>
);

describe("gabarits d'e-mail (React Email)", () => {
  it("[C-597] l'e-mail rendu n'a aucune image distante hors logo du paquet et contient une version texte", async () => {
    const html = await render(message);
    const sources = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]);
    expect(sources).toEqual(["cid:logo-axion"]);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    const texte = await render(message, { plainText: true });
    expect(texte).toContain("Bonjour Claire, une réponse est prête.");
    expect(texte).toContain("Relire la réponse");
    expect(texte).not.toMatch(/<[a-z][^>]*>/i);
  });

  it("[C-597] le logo de l'e-mail est celui d'AXION IA, jamais celui du client (décision F2-G3)", async () => {
    const html = await render(message);
    expect(html).toMatch(/<img[^>]*alt="AXION IA"/);
    expect(html).not.toMatch(/Lemoine[^<]*<img/);
  });

  it("[C-586] chaque couleur de l'e-mail vient des jetons", async () => {
    const html = await render(message);
    const permises = new Set(aplatir(jetons).map(([, valeur]) => valeur.toLowerCase()));
    for (const c of couleursDe(html)) expect(permises.has(c.toLowerCase()), c).toBe(true);
  });
});
