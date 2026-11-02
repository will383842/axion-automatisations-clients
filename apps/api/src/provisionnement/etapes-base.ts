import { ErreurEtape, type Etape, type LigneBase } from "./machine.js";

// Étapes 1, 2, 3 et 7 du provisionnement (T2-34) ; T2-35 ajoute 4, 5, 6, 8 et 9. Tout nom de base ou de rôle vient UNIQUEMENT de l'UUID validé (ADR 0046 : 12 premiers
// caractères hexadécimaux), cité par quote_ident côté serveur. Aucun mot de passe n'est écrit ailleurs que dans OpenBao ; seule son empreinte SCRAM va au serveur.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOM = /^cli_[0-9a-f]{12}(_proprietaire|_app|_lecture)?$/;
const MODELE = /^modele_v[0-9]{1,9}$/;
const EMPREINTE = /^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;
const PALIERS = [2, 4, 8];
export const GRAPPE_A_CHOISIR = "a_choisir";
const GENRES = ["proprietaire", "app", "lecture"] as const;

export function nomBaseDe(tenantId: string): string {
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new Error("tenantId invalide");
  return `cli_${tenantId.replaceAll("-", "").slice(0, 12)}`;
}
export function nomsRoles(tenantId: string): Record<(typeof GENRES)[number], string> {
  const base = nomBaseDe(tenantId);
  return { proprietaire: `${base}_proprietaire`, app: `${base}_app`, lecture: `${base}_lecture` };
}

export interface Sql {
  requete<T = Record<string, unknown>>(texte: string, valeurs?: unknown[]): Promise<T[]>;
}
// Connexion DIRECTE à la grappe avec le rôle provisionneur (jamais PgBouncer) ; CREATE DATABASE tourne hors transaction.
export interface Admin {
  baseExiste(nomBase: string): Promise<boolean>;
  creerBase(nomBase: string, modele: string): Promise<void>;
  rolesPresents(nomBase: string): Promise<string[]>;
  poserRole(role: string, empreinte: string): Promise<void>;
  fermer(nomBase: string): Promise<void>;
  connexionFermeeAuPublic(nomBase: string): Promise<boolean>;
}
export interface Coffre { ranger(chemin: string, valeur: string): Promise<void>; existe(chemin: string): Promise<boolean> }
export interface Bouncer { declarer(nomBase: string, pool: number): Promise<void>; recharger(): Promise<void>; repond(nomBase: string): Promise<boolean> }
export interface PortsBase {
  grappes(): Promise<{ nom: string; basesActives: number; octets: number }[]>;
  admin(grappe: string): Admin;
  coffre: Coffre;
  bouncer(grappe: string): Bouncer;
  registre: { poserGrappe(tenantId: string, grappe: string): Promise<void> };
  modele: string;
  palier(tenantId: string): Promise<number>;
  motDePasse(): string;
  empreinte(motDePasse: string): string;
}
export interface ContexteBase {
  tenantId: string;
  nomBase: string;
  ligne: LigneBase | undefined;
  grappe: string | undefined;
}
export const contexteBase = (tenantId: string, ligne: LigneBase | undefined): ContexteBase => ({
  tenantId,
  nomBase: nomBaseDe(tenantId),
  ligne,
  grappe: ligne && ligne.grappe !== GRAPPE_A_CHOISIR ? ligne.grappe : undefined,
});

export function adminPg(sql: Sql, dansBase?: (nomBase: string) => Sql): Admin {
  const citer = async (nom: string) => (await sql.requete<{ q: string }>("SELECT quote_ident($1) AS q", [nom]))[0]!.q;
  const verifier = (nom: string) => { if (!NOM.test(nom)) throw new Error("nom refusé"); };
  const noms = (base: string) => { verifier(base); return GENRES.map((g) => `${base}_${g}`); };
  return {
    async baseExiste(b) {
      verifier(b);
      return (await sql.requete("SELECT 1 FROM pg_database WHERE datname = $1", [b])).length > 0;
    },
    async creerBase(b, modele) {
      verifier(b);
      if (!MODELE.test(modele)) throw new Error("modèle refusé");
      await sql.requete(`CREATE DATABASE ${await citer(b)} TEMPLATE ${await citer(modele)}`);
    },
    async rolesPresents(b) {
      return (await sql.requete<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [noms(b)])).map((r) => r.rolname);
    },
    async poserRole(role, empreinte) {
      verifier(role);
      if (!EMPREINTE.test(empreinte)) throw new Error("empreinte refusée");
      const q = await citer(role);
      const existe = (await sql.requete("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).length > 0;
      if (!existe) {
        const connexion = role.endsWith("_proprietaire") ? "NOLOGIN" : `LOGIN NOINHERIT CONNECTION LIMIT ${role.endsWith("_app") ? 8 : 2}`;
        await sql.requete(`CREATE ROLE ${q} ${connexion} NOBYPASSRLS`);
        // Valeurs d'essai des limites (A-417), à définir au lot 8a comme dans creer-base.sql.
        if (!role.endsWith("_proprietaire")) for (const [cle, valeur] of [["statement_timeout", "5s"], ["work_mem", "4MB"]]) await sql.requete(`ALTER ROLE ${q} SET ${cle} = '${valeur}'`);
      }
      const [{ lit }] = (await sql.requete<{ lit: string }>("SELECT quote_literal($1) AS lit", [empreinte])) as [{ lit: string }];
      await sql.requete(`ALTER ROLE ${q} PASSWORD ${lit}`);
    },
    async fermer(b) {
      const [proprio, app, lecture] = (await Promise.all(noms(b).map(citer))) as [string, string, string];
      const base = await citer(b);
      await sql.requete(`GRANT ${proprio} TO CURRENT_USER WITH SET TRUE`);
      await sql.requete(`ALTER DATABASE ${base} OWNER TO ${proprio}`);
      await sql.requete(`REVOKE ALL ON DATABASE ${base} FROM PUBLIC`);
      await sql.requete(`GRANT CONNECT ON DATABASE ${base} TO ${app}, ${lecture}`);
      const dedans = dansBase?.(b);
      if (dedans) {
        for (const ordre of [
          `ALTER SCHEMA public OWNER TO ${proprio}`,
          "REVOKE ALL ON SCHEMA public FROM PUBLIC",
          `GRANT USAGE ON SCHEMA public TO ${app}, ${lecture}`,
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${proprio} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`,
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${proprio} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${app}`,
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${proprio} IN SCHEMA public GRANT SELECT ON TABLES TO ${lecture}`,
        ]) await dedans.requete(ordre);
      }
      // Retire au provisionneur tout accès au client (fonction du superutilisateur, init.sql de T2-31).
      await sql.requete("SELECT provisionnement.fermer_client($1)", [b.slice(4)]);
    },
    async connexionFermeeAuPublic(b) {
      verifier(b);
      const r = await sql.requete<{ ferme: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AND NOT EXISTS (SELECT 1 FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = $1 AND a.grantee = 0 AND a.privilege_type = 'CONNECT') AS ferme",
        [b],
      );
      return r[0]?.ferme === true;
    },
  };
}

const cheminSecret = (nomBase: string, genre: string) => `technique/donnees/${nomBase}/${genre}`;
const grappeDe = (ctx: ContexteBase): string => { if (!ctx.grappe) throw new ErreurEtape("grappe_absente"); return ctx.grappe; };
const attraper = <T>(code: string, f: () => Promise<T>): Promise<T> => f().catch((e: unknown) => { throw e instanceof ErreurEtape ? e : new ErreurEtape(code); });

export function etapesBase(p: PortsBase): Etape<ContexteBase>[] {
  return [
    {
      numero: 1,
      nom: "choix_grappe",
      dejaFait: async (ctx) => ctx.grappe !== undefined,
      async faire(ctx) {
        const choix = (await attraper("grappes_illisibles", () => p.grappes())).slice().sort((a, b) => a.basesActives - b.basesActives || a.octets - b.octets || a.nom.localeCompare(b.nom))[0];
        if (!choix) throw new ErreurEtape("aucune_grappe");
        await p.registre.poserGrappe(ctx.tenantId, choix.nom);
        ctx.grappe = choix.nom;
      },
    },
    {
      numero: 2,
      nom: "creation_base",
      // Faite = base physique ET ligne bases_client du client. Une base sans ligne n'est jamais branchée : la décision est humaine.
      dejaFait: async (ctx) => ctx.ligne !== undefined && (await attraper("grappe_injoignable", () => p.admin(grappeDe(ctx)).baseExiste(ctx.nomBase))),
      async faire(ctx) {
        const admin = p.admin(grappeDe(ctx));
        if (await attraper("grappe_injoignable", () => admin.baseExiste(ctx.nomBase))) throw new ErreurEtape("base_orpheline");
        await attraper("creation_base_echouee", () => admin.creerBase(ctx.nomBase, p.modele));
      },
    },
    {
      numero: 3,
      nom: "roles",
      async dejaFait(ctx) {
        const admin = p.admin(grappeDe(ctx));
        const noms = Object.values(nomsRoles(ctx.tenantId));
        const presents = await attraper("grappe_injoignable", () => admin.rolesPresents(ctx.nomBase));
        if (!noms.every((n) => presents.includes(n)) || !(await admin.connexionFermeeAuPublic(ctx.nomBase))) return false;
        return (await Promise.all(GENRES.map((g) => p.coffre.existe(cheminSecret(ctx.nomBase, g))))).every(Boolean);
      },
      async faire(ctx) {
        const admin = p.admin(grappeDe(ctx));
        const noms = nomsRoles(ctx.tenantId);
        // Mot de passe neuf à chaque passage : le rôle reçoit l'empreinte, PUIS le coffre reçoit le mot de passe. Un plantage entre les deux laisse un secret absent,
        // donc dejaFait faux et un nouveau tirage ; jamais un rôle dont le secret serait inconnu et réputé fait.
        for (const genre of GENRES) {
          const motDePasse = p.motDePasse();
          await attraper("role_echoue", () => admin.poserRole(noms[genre], p.empreinte(motDePasse)));
          await attraper("coffre_indisponible", () => p.coffre.ranger(cheminSecret(ctx.nomBase, genre), motDePasse));
        }
        await attraper("fermeture_echouee", () => admin.fermer(ctx.nomBase));
      },
    },
    {
      numero: 7,
      nom: "pgbouncer",
      dejaFait: async (ctx) => attraper("pgbouncer_injoignable", () => p.bouncer(grappeDe(ctx)).repond(ctx.nomBase)),
      async faire(ctx) {
        const pool = await p.palier(ctx.tenantId);
        if (!PALIERS.includes(pool)) throw new ErreurEtape("palier_invalide");
        const b = p.bouncer(grappeDe(ctx));
        await attraper("pgbouncer_injoignable", async () => { await b.declarer(ctx.nomBase, pool); await b.recharger(); });
        if (!(await attraper("pgbouncer_injoignable", () => b.repond(ctx.nomBase)))) throw new ErreurEtape("pgbouncer_ne_repond_pas");
      },
    },
  ];
}

// Coffre OpenBao (KV v2 monté sur technique/) : le jeton du rôle « provisionneur » écrit les secrets d'un client, sans jamais les relire. Aucun corps de réponse n'est repris dans une erreur.
const CHEMIN_SECRET = /^technique\/donnees\/(cli_[0-9a-f]{12}\/(?:proprietaire|app|lecture))$/;
export function coffreOpenBao(o: { url: string; jeton: string; fetch?: typeof fetch }): Coffre {
  const appeler = (methode: string, partie: "data" | "metadata", chemin: string, corps?: unknown): Promise<Response> => {
    const reste = CHEMIN_SECRET.exec(chemin)?.[1];
    if (!reste) throw new ErreurEtape("chemin_refuse");
    return (o.fetch ?? fetch)(`${o.url}/v1/technique/${partie}/donnees/${reste}`, {
      method: methode,
      headers: { "X-Vault-Token": o.jeton, "Content-Type": "application/json" },
      ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    }).catch(() => { throw new ErreurEtape("coffre_indisponible"); });
  };
  return {
    async ranger(chemin, valeur) {
      const r = await appeler("POST", "data", chemin, { data: { valeur } });
      if (!r.ok) throw new ErreurEtape("coffre_indisponible");
    },
    async existe(chemin) {
      const r = await appeler("GET", "metadata", chemin);
      if (r.status === 404) return false;
      if (!r.ok) throw new ErreurEtape("coffre_indisponible");
      return true;
    },
  };
}
