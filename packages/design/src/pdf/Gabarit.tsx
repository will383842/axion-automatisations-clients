/** @jsxRuntime automatic @jsxImportSource react */
import { Document, Page, StyleSheet } from "@react-pdf/renderer";
import type { ReactNode } from "react";
import { valeur } from "../jetons.ts";
import { declarerPolices } from "./polices.ts";

declarerPolices();

const styles = StyleSheet.create({
  page: { padding: 48, fontFamily: "Manrope", fontSize: 11, color: valeur("couleur.texte.principal"), backgroundColor: valeur("couleur.fond.carte") },
});

export function Gabarit({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <Document title={titre} language="fr" creator="AXION IA">
      <Page size="A4" style={styles.page}>
        {children}
      </Page>
    </Document>
  );
}
