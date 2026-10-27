/** @jsxRuntime automatic @jsxImportSource react */
import { StyleSheet, Text, View } from "@react-pdf/renderer";
import { valeur } from "../jetons.ts";

const styles = StyleSheet.create({
  bande: { borderBottomWidth: 2, borderBottomColor: valeur("couleur.action"), paddingBottom: 12, marginBottom: 24 },
  marque: { fontFamily: "Manrope", fontWeight: 800, fontSize: 10, color: valeur("couleur.actionTexte") },
  titre: { fontFamily: "Fraunces", fontWeight: 600, fontSize: 24, marginTop: 8 },
  client: { fontFamily: "Fraunces", fontWeight: 500, fontStyle: "italic", fontSize: 12, marginTop: 4, color: valeur("couleur.texte.secondaire") },
});

export function EnTete({ titre, client }: { titre: string; client?: string }) {
  return (
    <View style={styles.bande}>
      <Text style={styles.marque}>AXION IA</Text>
      <Text style={styles.titre}>{titre}</Text>
      {client ? <Text style={styles.client}>{client}</Text> : null}
    </View>
  );
}
