import type { ReactNode } from "react";
import "@axion-auto/design/src/jetons.css";
import "@axion-auto/design/src/polices.css";
import "@axion-auto/design/src/responsive.css";

export const metadata = { title: "AXION IA · console" };

export default function MiseEnPage({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
