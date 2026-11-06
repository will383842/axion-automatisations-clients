import { headers } from "next/headers.js";
import type { ReactNode } from "react";
import "@axion-auto/design/src/jetons.css";
import "@axion-auto/design/src/polices.css";
import "@axion-auto/design/src/responsive.css";

export const metadata = { title: "AXION IA · console" };

// Lire les en-têtes rend toute page dynamique : le middleware pose un nonce neuf par réponse (C-681), et Next ne l'ajoute qu'aux scripts
// d'une page rendue à la demande. Une page prérendue au build serait servie sans nonce, et la CSP bloquerait tous ses scripts.
export default async function MiseEnPage({ children }: { children: ReactNode }) {
  await headers();
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
