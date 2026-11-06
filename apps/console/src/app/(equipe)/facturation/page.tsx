import { messages } from "@axion-auto/design/src/textes/messages.fr.ts";

// Écran vide : le contenu arrive avec les fiches suivantes. Le texte vient du catalogue (T0-23).
const m = messages["vide.console.facturation"];
export default function Page() {
  return (
    <section aria-labelledby="titre">
      <h1 id="titre">Facturation</h1>
      <h2>{m.titre}</h2>
      <p>{m.phrase}</p>
    </section>
  );
}
