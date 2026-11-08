import { ErreurApi } from "../plugins/erreurs.js";
import { deroulerPlan, planifierVagues, type BaseRegistre, type ConfigVagues, type OptionsDeroulement, type PortsVagues } from "../donnees/vagues.js";
import { codeSchema, verifierMigrationsModule } from "./garde-migrations-module.js";

export { codeSchema };

// Tables d'un module chez les clients, par les vagues de T2-38 (T4-28b2, C-244, A-228, ADR 0125). Un ADAPTATEUR de ports : vagues.ts n'est pas modifié.
// Les tables d'un module sont par (client, module) : les instances test et production d'un même module chez un client partagent a_<code> ; les migrations étant additives, N et N-1 cohabitent.
// `noter` écrit dans deploiements_instance (jamais dans versions_structure, qui est la version du modèle). Aucun rôle créé ici : migrerBase (T2-32/T2-35) ouvre la connexion du module.
export interface InstanceDuModule { tenantId: string; instanceId: string; versionDepartId: string | null; configurationId: string | null; etat: string }
export interface LigneDeploiement {
  tenantId: string;
  instanceId: string;
  versionDepartId: string | null;
  versionCibleId: string;
  configurationId: string | null;
  resultat: "ok" | "echec" | "quarantaine";
  cause: string | null;
  vague: number | null;
}
export interface DepsTablesModule {
  // Code du manifeste (tirets) ; le schéma de la base est codeSchema(code).
  code: string;
  versionCibleId: string;
  // Numéro de la dernière migration de la version cible dans a_<code>.
  versionCible: number;
  config: ConfigVagues;
  // SQL des migrations de la version cible, extrait de l'artefact dont la signature a été vérifiée (T4-26/T4-27).
  migrationsSql(): Promise<string[]>;
  dossierMigrations(): Promise<string>;
  // bases_client de tous les clients ; les instances de CE module ; la version appliquée dans a_<code> d'une base.
  registre(): Promise<BaseRegistre[]>;
  instances(): Promise<InstanceDuModule[]>;
  versionAppliquee(nomBase: string, schema: string): Promise<number>;
  migrerBase(nomBase: string, version: number, options: { module: string; dossier: string }): Promise<void>;
  // Écrit une ligne de deploiements_instance sous la session du client de la ligne.
  ecrireDeploiement(ligne: LigneDeploiement): Promise<void>;
  graine: PortsVagues["graine"];
  enregistrerGraine: PortsVagues["enregistrerGraine"];
  tirerGraine: PortsVagues["tirerGraine"];
  alertes: { alerter(alerte: { type: "migration_echec"; clientId: string }): Promise<void> };
}

export async function deployerTablesModule(d: DepsTablesModule, options: OptionsDeroulement = {}): Promise<{ echecs: string[]; arretee: boolean }> {
  // A-300 : la garde passe AVANT toute lecture du registre et toute connexion.
  const refus = verifierMigrationsModule(await d.migrationsSql(), d.code);
  if (refus.length) throw new ErreurApi("regle_metier", `Les migrations du module sont refusées : ${refus.length} motif(s).`);
  const schema = codeSchema(d.code);
  let aMigrer: { base: BaseRegistre; instances: InstanceDuModule[] }[] = [];
  const ports: PortsVagues = {
    // Seules les bases des clients qui ont une instance de ce module (hors instance livrée) entrent dans le plan.
    async bases() {
      const instances = (await d.instances()).filter((i) => i.etat !== "livree");
      const bases = (await d.registre()).filter((b) => instances.some((i) => i.tenantId === b.tenantId));
      aMigrer = await Promise.all(bases.map(async (b) => ({ base: { ...b, versionStructure: await d.versionAppliquee(b.nomBase, schema) }, instances: instances.filter((i) => i.tenantId === b.tenantId) })));
      return aMigrer.map((x) => x.base);
    },
    graine: (v) => d.graine(v),
    enregistrerGraine: (v, g) => d.enregistrerGraine(v, g),
    tirerGraine: () => d.tirerGraine(),
    async migrer(nomBase, version) {
      await d.migrerBase(nomBase, version, { module: schema, dossier: await d.dossierMigrations() });
    },
    async noter(baseId, _version, resultat, vague) {
      const cible = aMigrer.find((x) => x.base.id === baseId);
      for (const i of cible?.instances ?? [])
        await d.ecrireDeploiement({ tenantId: i.tenantId, instanceId: i.instanceId, versionDepartId: i.versionDepartId, versionCibleId: d.versionCibleId, configurationId: i.configurationId, resultat, cause: resultat === "ok" ? null : "tables", vague });
    },
    alerter: (a) => d.alertes.alerter(a),
  };
  const plan = await planifierVagues(d.versionCible, d.config, ports);
  const r = await deroulerPlan(plan, ports, options);
  return { echecs: r.vagues.flatMap((v) => v.echecs).sort(), arretee: r.arretee };
}
