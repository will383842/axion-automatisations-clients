// Port des alertes. Le récepteur de test de T1A-12 branchera la version réelle ; ici, l'interface et une version en mémoire.
// Une alerte ne porte que son type et l'identifiant console du client, jamais son nom.
export interface Alerte {
  type: "soupcon_acces_non_autorise";
  clientId: string;
}
export interface Alertes {
  envoyer(alerte: Alerte): Promise<void>;
}
export function alertesEnMemoire(): Alertes & { envoyees: Alerte[] } {
  const envoyees: Alerte[] = [];
  return {
    envoyees,
    async envoyer(a) {
      envoyees.push({ type: a.type, clientId: a.clientId });
    },
  };
}
