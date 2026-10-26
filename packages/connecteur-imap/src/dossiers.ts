export type Dossier = { chemin: string; usageSpecial?: string };
export type DossiersSpeciaux = { envoyes?: string; brouillons?: string };

// RFC 6154 : un dossier se reconnaît à son attribut spécial, jamais à son nom affiché (qui change avec la langue).
export function trouverDossiers(liste: Dossier[]): DossiersSpeciaux {
  const chemin = (usage: string) => liste.find((d) => d.usageSpecial === usage)?.chemin;
  const envoyes = chemin("\\Sent");
  const brouillons = chemin("\\Drafts");
  return { ...(envoyes ? { envoyes } : {}), ...(brouillons ? { brouillons } : {}) };
}
