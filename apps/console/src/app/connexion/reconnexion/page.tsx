import { retourSur } from "../../../lib/connexion.ts";

// Page de reconnexion : session absente ou expirée. Le bouton renvoie vers /connexion, qui redemande le double facteur.
export default async function Page({ searchParams }: { searchParams: Promise<{ retour?: string | string[] }> }) {
  const brut = (await searchParams).retour;
  const retour = retourSur(typeof brut === "string" ? brut : null);
  return (
    <main id="contenu" className="r-contenu" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--espacement-24)", padding: "var(--espacement-48) var(--espacement-32)", background: "var(--couleur-fond-console)", minHeight: "100vh", boxSizing: "border-box" }}>
      <section aria-labelledby="t-connexion" style={{ maxWidth: "calc(var(--espacement-48) * 11)", width: "100%", background: "var(--couleur-fond-carte)", borderRadius: "var(--rayon-12)", padding: "var(--espacement-32)", display: "flex", flexDirection: "column", gap: "var(--espacement-24)", boxSizing: "border-box" }}>
        <h1 id="t-connexion" style={{ margin: 0, fontWeight: 800 }}>Connexion à la console</h1>
        <p style={{ margin: 0 }}>Confirmez que c’est bien vous. <strong>La console redemande toujours votre identité</strong>, même si vous êtes déjà connecté au site : elle donne accès aux données de tous vos clients.</p>
        <form action="/connexion" method="get">
          <input type="hidden" name="retour" value={retour} />
          <button type="submit" style={{ minHeight: "var(--espacement-48)", padding: "0 var(--espacement-24)", background: "var(--couleur-action)", color: "var(--couleur-menu-texte)", border: 0, borderRadius: "var(--rayon-8)", fontWeight: 800, fontSize: "var(--taille-texteMobile)", cursor: "pointer" }}>Se connecter</button>
        </form>
      </section>
    </main>
  );
}
