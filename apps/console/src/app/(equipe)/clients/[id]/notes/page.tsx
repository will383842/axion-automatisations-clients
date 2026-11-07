// Onglet « Notes » : notes, appels et échanges, épinglage, « Noter l'appel et clore l'alerte ». Les données arrivent par l'API des notes (routes/clients/notes.ts), derrière son interrupteur.
export default function Page() {
  return (
    <section aria-labelledby="titre-notes">
      <h2 id="titre-notes">Notes</h2>
      <p>Les notes de ce client apparaissent ici, les notes épinglées en premier.</p>
    </section>
  );
}
