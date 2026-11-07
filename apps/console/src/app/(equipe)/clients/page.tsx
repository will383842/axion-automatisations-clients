import { ListeClients } from "./ListeClients.tsx";

// Espace Clients : la liste vient de GET /api/console/v1/clients (route derrière un interrupteur fermé) ; tant qu'elle n'est pas branchée, la liste est vide.
export default function Page() {
  return (
    <section aria-labelledby="titre">
      <h1 id="titre">Clients</h1>
      <ListeClients lignes={[]} />
    </section>
  );
}
