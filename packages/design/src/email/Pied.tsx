/** @jsxRuntime automatic @jsxImportSource react */
import { Hr, Text } from "@react-email/components";
import { jetons, valeur } from "../jetons.ts";

export function Pied() {
  return (
    <>
      <Hr style={{ width: "100%", border: "none", borderTop: `1px solid ${valeur("couleur.separateur")}`, margin: `${jetons.espacement[24]} 0 ${jetons.espacement[12]}` }} />
      <Text style={{ margin: 0, fontSize: jetons.taille.precision, color: valeur("couleur.texte.secondaire") }}>Propulsé par AXION IA · axion-ia.com</Text>
    </>
  );
}
