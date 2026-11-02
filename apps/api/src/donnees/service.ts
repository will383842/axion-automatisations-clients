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
  // Vue « comme le client » (T2-37c) : l'accord est revérifié à CHAQUE appel, et la vue est celle rangée côté serveur à son ouverture (vue-client.ts), jamais celle que porte la session.
  accordValide(tenantId: string, instant: Date): Promise<boolean>;
  vueRangee(acteur: string, tenantId: string): Promise<{ expireLe: Date } | undefined> | { expireLe: Date } | undefined;
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

// Compatibilité N / N-1 (A-229) : une requête peut avoir plusieurs textes ; la variante est choisie d'après la version de structure LUE dans la base du client (public.version_structure),
// jamais d'après une valeur de la session ou de la requête. `depuis` : première version où le texte vaut ; le texte de base sert en dessous. Version illisible : le texte le plus ancien.
export type RequeteAvecVariantes = Requete & { variantes?: readonly { depuis: number; sql: string }[] };

export function creerServiceDonnees(ports: PortsDonnees, liste: Readonly<Record<string, RequeteAvecVariantes>> = LISTE_BLANCHE) {
  const pools = new Map<string, { connexion: Promise<Connexion>; dernierUsage: number; enCours: number }>();

  function pool(nomBase: string, role: RoleConnexion): Promise<Connexion> {
    const cle = `${nomBase}|${role}`;
    let p = pools.get(cle);
    if (!p) {
      const connexion = ports.ouvrir(nomBase, role);
      p = { connexion, dernierUsage: ports.maintenant().getTime(), enCours: 0 };
      pools.set(cle, p);
      connexion.catch(() => { if (pools.get(cle) === p) pools.delete(cle); });
    }
    p.dernierUsage = ports.maintenant().getTime();
    return p.connexion;
  }

  // La session ne fait que RÉCLAMER une vue : elle ne vaut que si la vue rangée côté serveur existe pour CET acteur et CE client, n'est pas périmée (la plus courte des deux fins
  // l'emporte, une session allongée ne gagne rien) et si l'accord est encore valide à cet instant. Un accord illisible vaut pas d'accord.
  async function vueValide(session: SessionDonnees): Promise<boolean> {
    if (!session.vue || session.vue.tenantId !== session.tenantId) return false;
    const maintenant = ports.maintenant();
    const rangee = await Promise.resolve(ports.vueRangee(session.acteur, session.tenantId)).catch(() => undefined);
    if (!rangee || !(maintenant < rangee.expireLe) || !(maintenant < session.vue.expireLe)) return false;
    return ports.accordValide(session.tenantId, maintenant).catch(() => false);
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
        const vue = await vueValide(session);
        if (vue ? r.mode !== "lecture" : !r.metadonnees || r.mode !== "lecture") throw refus("action_interdite", "Action interdite.");
      }
      const p = r.schema.safeParse(parametres ?? {});
      if (!p.success) throw refus("schema_invalide", "Requête invalide.");

      const base = await ports.base(session.tenantId).catch(() => { throw refus("porte_fermee", "Service indisponible."); });
      if (!base || base.etat !== "active") throw refus("introuvable", "Ressource introuvable.");

      const role: RoleConnexion = r.mode === "ecriture" && session.role === "client" ? "app" : "lecture";
      const cle = `${base.nomBase}|${role}`;
      let compte: { enCours: number; dernierUsage: number } | undefined;
      try {
        const connexion = await pool(base.nomBase, role);
        compte = pools.get(cle);
        if (compte) compte.enCours += 1;
        // L'équipe n'a pas d'établissements dans sa session : ceux du client sont lus dans sa base, par la connexion de lecture.
        const etablissements = session.role === "client" ? session.etablissements : (await (await pool(base.nomBase, "lecture")).requete("SELECT id FROM commun.etablissements", [])).map((l) => String(l["id"]));
        const valeurs = r.valeurs(p.data as never);
        let modele = r.sql;
        if (r.variantes?.length) {
          const lue = Number((await connexion.requete("SELECT coalesce(max(version), 0) AS v FROM public.version_structure", []))[0]?.["v"]);
          const choisie = Number.isInteger(lue) ? [...r.variantes].filter((v) => v.depuis <= lue).sort((a, b) => b.depuis - a.depuis)[0] : undefined;
          if (choisie) modele = choisie.sql;
        }
        const texte = modele.replaceAll(EMPLACEMENT_FILTRE, `etablissement_id = ANY($${valeurs.length + 1}::uuid[])`);
        // Les numéros $n écrits dans la requête sont exactement 1..N, N = nombre de valeurs de la requête ; le service y ajoute le tableau d'établissements en $N+1 (B-173).
        // Ni valeur orpheline, ni numéro sans valeur, ni numéro pris deux fois par le filtre.
        const numeros = new Set([...modele.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
        if (numeros.size !== valeurs.length || valeurs.some((_, i) => !numeros.has(i + 1))) throw refus("schema_invalide", "Requête invalide.");
        const envoyees = r.parEtablissement ? [...valeurs, etablissements] : valeurs;
        const lignes = await connexion.requete(texte, envoyees);
        return lignes.map((l) => Object.fromEntries(r.colonnes.filter((c) => c in l).map((c) => [c, l[c]])));
      } catch (e) {
        // Aucun détail technique ni nom de base ne sort.
        throw e instanceof ErreurApi ? e : refus("porte_fermee", "Service indisponible.");
      } finally {
        // Le pool est de nouveau « actif » à la fin de la requête : le délai d'inactivité repart de là.
        if (compte) { compte.enCours -= 1; compte.dernierUsage = ports.maintenant().getTime(); }
      }
    },
    async balayer(inactiviteMs: number): Promise<void> {
      const limite = ports.maintenant().getTime() - inactiviteMs;
      for (const [cle, p] of [...pools]) {
        // Un pool qui sert une requête n'est jamais fermé, quel que soit son âge.
        if (p.dernierUsage >= limite || p.enCours > 0) continue;
        pools.delete(cle);
        await (await p.connexion).fermer().catch(() => undefined);
      }
    },
    // Minuterie de fermeture des pools inactifs ; rend l'arrêt. Les fonctions de minuterie sont injectables pour les essais.
    planifierBalayage(inactiviteMs: number, t: { setInterval(f: () => void, ms: number): unknown; clearInterval(h: unknown): void } = { setInterval: (f, ms) => { const h = setInterval(f, ms); h.unref(); return h; }, clearInterval: (h) => clearInterval(h as NodeJS.Timeout) }): () => void {
      const h = t.setInterval(() => void this.balayer(inactiviteMs).catch(() => undefined), Math.max(1000, Math.floor(inactiviteMs / 2)));
      return () => t.clearInterval(h);
    },
    async fermer(): Promise<void> {
      await this.balayer(-1);
    },
  };
}
