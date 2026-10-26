/** @jsxRuntime automatic @jsxImportSource react */
import { StyleSheet, Text } from "@react-pdf/renderer";
import { valeur } from "../jetons.ts";

const styles = StyleSheet.create({
  pied: { position: "absolute", bottom: 24, left: 48, right: 48, fontSize: 9, color: valeur("couleur.texte.secondaire"), textAlign: "center" },
});

export function Pied() {
  return (
    <Text style={styles.pied} fixed render={({ pageNumber, totalPages }) => `Propulsé par AXION IA · page ${pageNumber} sur ${totalPages}`} />
  );
}
