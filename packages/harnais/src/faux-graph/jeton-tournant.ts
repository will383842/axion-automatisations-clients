import { randomBytes } from "node:crypto";

// Jeton de renouvellement TOURNANT, comme chez Microsoft et Google : chaque usage en rend un nouveau et invalide l'ancien.
// Réutiliser un jeton déjà consommé révoque toute la lignée (le dernier jeton aussi) : le client est déconnecté.
export type Tournant = {
  actifs: Map<string, string>; // jeton actif -> lignée
  consommes: Map<string, string>; // jeton consommé -> lignée
  revoquees: Set<string>;
  appels: number;
  emettre(clientId: string): string;
  echanger(jeton: string): { refresh_token: string } | "invalid_grant";
};
export function nouveauTournant(): Tournant {
  const t: Tournant = {
    actifs: new Map(), consommes: new Map(), revoquees: new Set(), appels: 0,
    emettre(clientId) {
      const jeton = `faux-rt-${randomBytes(12).toString("hex")}`;
      t.actifs.set(jeton, clientId);
      return jeton;
    },
    echanger(jeton) {
      t.appels++;
      const reutilise = t.consommes.get(jeton);
      if (reutilise !== undefined) { t.revoquees.add(reutilise); for (const [j, l] of t.actifs) if (l === reutilise) t.actifs.delete(j); return "invalid_grant"; }
      const lignee = t.actifs.get(jeton);
      if (lignee === undefined || t.revoquees.has(lignee)) return "invalid_grant";
      t.actifs.delete(jeton);
      t.consommes.set(jeton, lignee);
      return { refresh_token: t.emettre(lignee) };
    },
  };
  return t;
}
