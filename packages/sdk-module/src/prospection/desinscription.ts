import type { MessageDeProspection } from "./message.ts";

// Brique commune : une opposition met le contact à l'ÉCART des envois, la donnée est gardée.
// L'interface n'offre volontairement aucune suppression. La portée de la liste entre clients
// n'est pas tranchée (ADR 0026) : cette liste est celle d'un seul périmètre, choisi par l'appelant.
export type Opposition = { readonly adresse: string; readonly date: string };

export type ListeExclusion = {
  contient(adresse: string): boolean;
  ajouter(opposition: Opposition): void;
  entrees(): readonly Opposition[];
};

export const normaliserAdresse = (adresse: string): string => adresse.trim().toLowerCase();

export function creerListeExclusion(initiales: readonly Opposition[] = []): ListeExclusion {
  const parAdresse = new Map<string, Opposition>();
  const liste: ListeExclusion = {
    contient: (adresse) => parAdresse.has(normaliserAdresse(adresse)),
    ajouter: (o) => {
      const adresse = normaliserAdresse(o.adresse);
      if (!parAdresse.has(adresse)) parAdresse.set(adresse, { adresse, date: o.date });
    },
    entrees: () => [...parAdresse.values()],
  };
  for (const o of initiales) liste.ajouter(o);
  return liste;
}

export function enregistrerOpposition(liste: ListeExclusion, adresse: string, date: string): void {
  if (!normaliserAdresse(adresse)) throw new Error("opposition : adresse vide");
  liste.ajouter({ adresse, date });
}

// À appeler juste avant l'envoi : un contact exclu ne reçoit plus rien.
export function verifierEnvoi(liste: ListeExclusion, message: MessageDeProspection): void {
  if (liste.contient(message.a)) throw new Error("envoi refusé : le destinataire est exclu (opposition enregistrée)");
}
