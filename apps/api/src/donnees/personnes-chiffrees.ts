import { randomUUID } from "node:crypto";
import { normaliserEmail, normaliserTelephone, type creerColonnesChiffrees } from "./colonnes-chiffrees.js";

// Rangement et lecture de commun.personnes par les fonctions de T2-33 (A-201, A-243).
// L'e-mail et le téléphone ne sont jamais écrits en clair : la base reçoit le chiffré (contexte « personnes.<colonne>_chiffre » + identifiant de la ligne)
// et l'empreinte de recherche (32 octets). Le SQL est paramétré et passe par la connexion fournie par l'appelant (pg.Pool, pg.Client ou la liste blanche de T2-37).
// Unicode : l'adresse est mise en NFC AVANT l'empreinte et le chiffrement, pour que deux graphies d'une même adresse (accent composé ou décomposé) donnent la même empreinte.
// Pas de repli : sans clé du client ou coffre scellé, le coffre refuse (ErreurCoffre) et rien n'est écrit.

type Colonnes = Pick<ReturnType<typeof creerColonnesChiffrees>, "chiffrerChamp" | "dechiffrerChamp" | "empreinteRecherche">;

export interface ClientSql {
  query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PersonneARanger {
  etablissementId: string;
  entrepriseId?: string | null;
  nom: string;
  prenom?: string | null;
  courriel?: string | null;
  telephone?: string | null;
}

export interface PersonneLue {
  id: string;
  etablissementId: string;
  entrepriseId: string | null;
  nom: string;
  prenom: string | null;
  courriel: string | null;
  telephone: string | null;
}

const COL_COURRIEL = "personnes.courriel_chiffre";
const COL_TELEPHONE = "personnes.telephone_chiffre";
const nfc = (v: string) => v.normalize("NFC");
const present = (v: string | null | undefined): v is string => typeof v === "string" && v !== "";

export function creerPersonnesChiffrees(o: { colonnes: Colonnes; sql: ClientSql }) {
  const { colonnes, sql } = o;
  const octets = (v: unknown): Uint8Array | null => (v instanceof Uint8Array ? v : null);
  return {
    /** Range une personne et rend l'identifiant de sa ligne. Un e-mail ou un téléphone invalide est refusé avant toute écriture. */
    async ranger(tenantId: string, p: PersonneARanger): Promise<string> {
      const id = randomUUID();
      const courriel = present(p.courriel) ? nfc(p.courriel) : null;
      const telephone = present(p.telephone) ? nfc(p.telephone) : null;
      // Forme validée ici (empreinteRecherche choisit e-mail ou téléphone d'après la présence d'un « @ ») puis empreintes, avant tout chiffrement.
      if (courriel !== null) normaliserEmail(courriel);
      if (telephone !== null) normaliserTelephone(telephone);
      const empCourriel = courriel === null ? null : await colonnes.empreinteRecherche(tenantId, courriel);
      const empTelephone = telephone === null ? null : await colonnes.empreinteRecherche(tenantId, telephone);
      const chCourriel = courriel === null ? null : await colonnes.chiffrerChamp(tenantId, courriel, { colonne: COL_COURRIEL, idLigne: id });
      const chTelephone = telephone === null ? null : await colonnes.chiffrerChamp(tenantId, telephone, { colonne: COL_TELEPHONE, idLigne: id });
      await sql.query(
        "INSERT INTO commun.personnes (id, etablissement_id, entreprise_id, nom, prenom, courriel_chiffre, courriel_empreinte, telephone_chiffre, telephone_empreinte) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [id, p.etablissementId, p.entrepriseId ?? null, p.nom, p.prenom ?? null, chCourriel, empCourriel, chTelephone, empTelephone],
      );
      return id;
    },

    /** Lit une personne et déchiffre avec le contexte de SA ligne : un chiffré copié d'une autre ligne est refusé (ErreurCoffre). */
    async lire(tenantId: string, idLigne: string): Promise<PersonneLue | undefined> {
      const r = (await sql.query("SELECT id, etablissement_id, entreprise_id, nom, prenom, courriel_chiffre, telephone_chiffre FROM commun.personnes WHERE id = $1", [idLigne])).rows[0];
      if (!r) return undefined;
      const c = octets(r["courriel_chiffre"]);
      const t = octets(r["telephone_chiffre"]);
      return {
        id: String(r["id"]),
        etablissementId: String(r["etablissement_id"]),
        entrepriseId: (r["entreprise_id"] as string | null) ?? null,
        nom: String(r["nom"]),
        prenom: (r["prenom"] as string | null) ?? null,
        courriel: c ? await colonnes.dechiffrerChamp(tenantId, c, { colonne: COL_COURRIEL, idLigne }) : null,
        telephone: t ? await colonnes.dechiffrerChamp(tenantId, t, { colonne: COL_TELEPHONE, idLigne }) : null,
      };
    },

    /** Cherche par empreinte (index établissement + empreinte), sans rien déchiffrer. */
    async trouverParCourriel(tenantId: string, etablissementId: string, courriel: string): Promise<string[]> {
      const empreinte = await colonnes.empreinteRecherche(tenantId, normaliserEmail(nfc(courriel)));
      const r = await sql.query("SELECT id FROM commun.personnes WHERE etablissement_id = $1 AND courriel_empreinte = $2", [etablissementId, empreinte]);
      return r.rows.map((l) => String(l["id"]));
    },
  };
}
