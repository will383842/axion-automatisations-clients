import { z } from "zod";
import { ErreurApi } from "../plugins/erreurs.js";
import { EMPLACEMENT_FILTRE, LISTE_BLANCHE, type Requete } from "./requetes/liste.js";

// Seul chemin du portail et de la console vers la base d'un client (A-170). Tout ce qui décide de la base vient de la SESSION :
//   - le client (tenantId), le rôle et les établissements permis ; rien de tel n'est lu dans l'URL, le corps, un en-tête ou un cookie (C-536) ;
//   - la base vient de bases_client pour ce client, état « active » seulement (sinon « introuvable », sans dire pourquoi) ;
//   - aucun repli : pas de base, pas de pool, pas de requête.
// Une connexion par (base, rôle), fermée après inactivité ; elle n'est jamais rendue à une autre base.
export type RoleConnexion = "app" | "lecture";
export interface Connexion {
  requete(texte: string, valeurs: unknown[]): Promise<Record<string, unknown>[]>;
  fermer(): Promise<void>;
}
export interface PortsDonnees {
  base(tenantId: string): Promise<{ nomBase: string; etat: string } | undefined>;
  // L'adaptateur lit le mot de passe dans OpenBao (politique api) et passe par PgBouncer « données » ; le service ne voit jamais le mot de passe.
  ouvrir(nomBase: string, role: RoleConnexion): Promise<Connexion>;
  maintenant(): Date;
}

const Session = z.object({
  tenantId: z.uuid(),
  role: z.enum(["client", "equipe"]),
  acteur: z.string().min(1),
  etablissements: z.array(z.uuid()),
  vue: z.object({ tenantId: z.uuid(), expireLe: z.date() }).optional(),
});
export type SessionDonnees = z.infer<typeof Session>;

const refus = (code: "action_interdite" | "introuvable" | "schema_invalide" | "porte_fermee", message: string) => new ErreurApi(code, message);

export function creerServiceDonnees(ports: PortsDonnees, liste: Readonly<Record<string, Requete>> = LISTE_BLANCHE) {
  const pools = new Map<string, { connexion: Promise<Connexion>; dernierUsage: number }>();

  function pool(nomBase: string, role: RoleConnexion): Promise<Connexion> {
    const cle = `${nomBase}|${role}`;
    let p = pools.get(cle);
    if (!p) {
      const connexion = ports.ouvrir(nomBase, role);
      p = { connexion, dernierUsage: ports.maintenant().getTime() };
      pools.set(cle, p);
      connexion.catch(() => pools.delete(cle));
    }
    p.dernierUsage = ports.maintenant().getTime();
    return p.connexion;
  }

  return {
    async executer(sessionBrute: SessionDonnees, nom: string, parametres: unknown): Promise<Record<string, unknown>[]> {
      const s = Session.safeParse(sessionBrute);
      if (!s.success) throw refus("action_interdite", "Action interdite.");
      const session = s.data;
      const r = Object.hasOwn(liste, nom) ? liste[nom] : undefined;
      if (!r) throw refus("schema_invalide", "Requête invalide.");

      // Équipe : métadonnées seulement, sauf vue « comme le client » encore valide pour CE client, qui reste en lecture seule (B-070, C-006, A-005).
      if (session.role === "equipe") {
        const vue = session.vue && session.vue.tenantId === session.tenantId && ports.maintenant() < session.vue.expireLe;
        if (vue ? r.mode !== "lecture" : !r.metadonnees || r.mode !== "lecture") throw refus("action_interdite", "Action interdite.");
      }
      const p = r.schema.safeParse(parametres ?? {});
      if (!p.success) throw refus("schema_invalide", "Requête invalide.");

      const base = await ports.base(session.tenantId).catch(() => { throw refus("porte_fermee", "Service indisponible."); });
      if (!base || base.etat !== "active") throw refus("introuvable", "Ressource introuvable.");

      const role: RoleConnexion = r.mode === "ecriture" && session.role === "client" ? "app" : "lecture";
      try {
        const connexion = await pool(base.nomBase, role);
        // L'équipe n'a pas d'établissements dans sa session : ceux du client sont lus dans sa base, par la connexion de lecture.
        const etablissements = session.role === "client" ? session.etablissements : (await (await pool(base.nomBase, "lecture")).requete("SELECT id FROM commun.etablissements", [])).map((l) => String(l["id"]));
        const valeurs = r.valeurs(p.data as never);
        const texte = r.sql.replaceAll(EMPLACEMENT_FILTRE, `etablissement_id = ANY($${valeurs.length + 1}::uuid[])`);
        const lignes = await connexion.requete(texte, r.parEtablissement ? [...valeurs, etablissements] : valeurs);
        return lignes.map((l) => Object.fromEntries(r.colonnes.filter((c) => c in l).map((c) => [c, l[c]])));
      } catch (e) {
        // Aucun détail technique ni nom de base ne sort.
        throw e instanceof ErreurApi ? e : refus("porte_fermee", "Service indisponible.");
      }
    },
    async balayer(inactiviteMs: number): Promise<void> {
      const limite = ports.maintenant().getTime() - inactiviteMs;
      for (const [cle, p] of [...pools]) {
        if (p.dernierUsage >= limite) continue;
        pools.delete(cle);
        await (await p.connexion).fermer().catch(() => undefined);
      }
    },
    async fermer(): Promise<void> {
      await this.balayer(-1);
    },
  };
}
