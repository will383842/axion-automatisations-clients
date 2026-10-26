/** @jsxRuntime automatic @jsxImportSource react */
import { Body, Container, Head, Html, Img, Preview, Section } from "@react-email/components";
import type { ReactNode } from "react";
import { jetons, valeur } from "../jetons.ts";

// Gabarit d'e-mail (C-597) : le logo est TOUJOURS celui d'AXION IA, jamais celui du client avant la connexion (F2-G3).
// Le logo est une pièce jointe incorporée (cid) : aucune image n'est chargée depuis Internet.
export function Gabarit({ titre, apercu, children }: { titre: string; apercu?: string; children: ReactNode }) {
  return (
    <Html lang="fr">
      <Head>
        <title>{titre}</title>
      </Head>
      {apercu ? <Preview>{apercu}</Preview> : null}
      <Body style={{ margin: 0, padding: jetons.espacement[24], background: valeur("couleur.fond.portail"), fontFamily: jetons.police.texte, fontSize: jetons.taille.texte, color: valeur("couleur.texte.principal") }}>
        <Container style={{ maxWidth: "600px", margin: "0 auto" }}>
          <Section style={{ padding: `${jetons.espacement[16]} 0` }}>
            <Img src="cid:logo-axion" alt="AXION IA" height={32} />
          </Section>
          <Section style={{ background: valeur("couleur.fond.carte"), border: `1px solid ${valeur("couleur.bordure.carte")}`, borderRadius: jetons.rayon[16], padding: jetons.espacement[24] }}>
            <h1 style={{ margin: `0 0 ${jetons.espacement[16]}`, fontFamily: jetons.police.titre, fontSize: jetons.taille.titreCarte, fontWeight: 600 }}>{titre}</h1>
            {children}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
