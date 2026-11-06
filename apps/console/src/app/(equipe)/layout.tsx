import { redirect } from "next/navigation.js";
import { headers } from "next/headers.js";
import type { ReactNode } from "react";
import { LienEvitement } from "@axion-auto/design/src/composants/base.tsx";
import { BarreOnglets, EnTeteTelephone, MenuLateral } from "@axion-auto/design/src/composants/navigation.tsx";
import { valeur } from "@axion-auto/design/src/jetons.ts";
import { adresseBackOffice } from "../../lib/configuration.ts";
import { COMPTE, ONGLETS, actifDe, entreesPour, niveauDe } from "../../lib/navigation.ts";
import { COOKIE_SESSION, lireCookie, magasin } from "../../lib/session.ts";

// Logo fictif dessiné avec le jeton du menu : aucune image distante.
const LOGO = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32" viewBox="0 0 120 32"><text x="0" y="24" font-family="sans-serif" font-size="22" font-weight="800" fill="${valeur("couleur.menu.texte")}">Axion IA</text></svg>`)}`;
const v = (n: string) => `var(--${n})`;

// La disposition revérifie la session elle-même (le middleware ne voit que la présence du cookie).
export default async function MiseEnPage({ children }: { children: ReactNode }) {
  const entetes = await headers();
  const chemin = entetes.get("x-chemin") ?? "/";
  const id = lireCookie(entetes.get("cookie"), COOKIE_SESSION);
  if (!id || !magasin.lireSession(id)) redirect(`/connexion/reconnexion?retour=${encodeURIComponent(chemin)}`);
  const actif = actifDe(chemin) ?? "";
  const retourBO = adresseBackOffice();
  return (
    <div className="r-racine" style={{ display: "flex", minHeight: "100vh", background: v("couleur-fond-console") }}>
      <LienEvitement cible="contenu" />
      <EnTeteTelephone logo={LOGO} nomLogo="AXION IA" />
      <MenuLateral variante="console" actif={actif} logoAxion={LOGO} entrees={entreesPour(niveauDe(chemin))} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", gap: v("espacement-16"), alignItems: "center", justifyContent: "flex-end", padding: v("espacement-12") }}>
          {retourBO ? <a href={retourBO}>Back-office d’axion-ia</a> : null}
          <a href={COMPTE.href} aria-current={actif === "" && chemin.startsWith(COMPTE.href) ? "page" : undefined}>{COMPTE.libelle}</a>
        </div>
        <main id="contenu" className="r-contenu" style={{ flex: 1, padding: v("espacement-32") }}>{children}</main>
        <BarreOnglets variante="console" actif={ONGLETS.some(([o]) => o === actif) ? actif : "plus"} />
      </div>
    </div>
  );
}
