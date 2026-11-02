import type pg from "pg";
import { PLATEFORME_ID } from "../../db/schema/aides.ts";
import type { AlerteC3, DepotC3, Exclusion, FaitCrm, OrganisationLue, ResultatFait, TxC3 } from "./types.js";

// Adaptateur Postgres des ports du récepteur C3 (T2-17b, ADR 0106). Un seul rôle d'écriture (console_app) : une transaction, le client actif change par instruction
// (set_config local, jamais de SET de session derrière PgBouncer). Les LECTURES entre clients (fiche par identifiant CRM ou par SIREN, liens absorbés, exclusions d'un client)
// passent par le pool de l'équipe, en lecture seule (console_equipe). Aucune suppression : une opposition est une exclusion durable par empreinte.
export interface DepsDepotSql {
  app: pg.Pool;
  equipe: pg.Pool;
}
const ACTEUR = "recepteur-c3";
const DELAIS = "SELECT set_config('idle_in_transaction_session_timeout', '5s', true), set_config('lock_timeout', '5s', true)";
const COLONNES_ORG = "id, raison_sociale, siren, crm_company_id";
type LigneOrg = { id: string; raison_sociale: string; siren: string | null; crm_company_id: string | null };
const lue = (o: LigneOrg): OrganisationLue => ({ id: o.id, raisonSociale: o.raison_sociale, siren: o.siren, crmCompanyId: o.crm_company_id });

export function creerDepotSql(deps: DepsDepotSql): DepotC3 & { estExclue(clientId: string, empreinte: string): Promise<boolean> } {
  return {
    async transaction(fn) {
      const client = await deps.app.connect();
      let detruire = false;
      try {
        await client.query("BEGIN");
        await client.query(DELAIS);
        await client.query("SELECT set_config('app.acteur', $1, true)", [ACTEUR]);
        const resultat = await fn(creerTx(client, deps.equipe));
        try {
          await client.query("COMMIT");
        } catch (e) {
          detruire = true;
          throw e;
        }
        return resultat;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => (detruire = true));
        throw e;
      } finally {
        client.release(detruire);
      }
    },
    // Envoi commercial : exclu si l'empreinte est dans la liste de la plateforme, ou dans celle d'une fiche CRM du client (actuelle ou absorbée).
    async estExclue(clientId, empreinte) {
      const r = await deps.equipe.query(
        `SELECT 1 FROM exclusions_c3 e WHERE e.tenant_id = $1 AND e.empreinte = $2 AND (e.portee = '*' OR e.portee IN (
           SELECT crm_company_id FROM organisations WHERE tenant_id = $3 AND crm_company_id IS NOT NULL
           UNION SELECT crm_company_id FROM liens_crm WHERE tenant_id = $3)) LIMIT 1`,
        [PLATEFORME_ID, empreinte, clientId],
      );
      return (r.rowCount ?? 0) > 0;
    },
  };
}

function creerTx(client: pg.PoolClient, equipe: pg.Pool): TxC3 {
  let eventCourant = "";
  // Une instruction d'écriture sous le client actif donné (la politique RLS compare tenant_id à ce réglage, valable jusqu'à la fin de la transaction).
  const sous = async (tenant: string, texte: string, valeurs: unknown[]) => {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    return client.query(texte, [tenant, ...valeurs]);
  };
  const donnees = (orgId: string, sorte: "copie" | "ecart" | "apporteur", contenu: object) =>
    sous(orgId, `INSERT INTO donnees_crm_c3 (tenant_id, id, organisation_id, event_id, sorte, contenu) VALUES ($1, gen_random_uuid(), $1, $2, $3, $4) ON CONFLICT (tenant_id, event_id, sorte) DO NOTHING`, [eventCourant, sorte, JSON.stringify(contenu)]);
  const rangerLigneFait = (f: { eventId: string; type: string; sequence: number; sujet: string }) =>
    sous(PLATEFORME_ID, `INSERT INTO faits_recus (tenant_id, id, source, event_id, type, sequence, sujet) VALUES ($1, gen_random_uuid(), 'crm', $2, $3, $4, $5) ON CONFLICT (tenant_id, source, event_id) DO NOTHING`, [f.eventId, f.type, f.sequence, f.sujet]);
  return {
    async recevoir(f: FaitCrm) {
      await rangerLigneFait({ eventId: f.event_id, type: f.event_type, sequence: f.sequence, sujet: f.subject_ref.crmCompanyId });
      const r = await sous(PLATEFORME_ID, `INSERT INTO contenus_c3 (tenant_id, id, event_id, contenu) VALUES ($1, gen_random_uuid(), $2, $3) ON CONFLICT (tenant_id, event_id) DO NOTHING`, [f.event_id, JSON.stringify(f)]);
      return (r.rowCount ?? 0) > 0;
    },
    async contenu(eventId) {
      const r = await sous(PLATEFORME_ID, "SELECT contenu FROM contenus_c3 WHERE tenant_id = $1 AND event_id = $2", [eventId]);
      return (r.rows[0] as { contenu: unknown } | undefined)?.contenu ?? null;
    },
    // Vrai si le fait n'est pas encore traité (la ligne est verrouillée jusqu'à la fin de la transaction : deux travailleurs ne le traitent pas deux fois).
    async rangerFait(f) {
      eventCourant = f.eventId;
      await rangerLigneFait(f);
      const r = await sous(PLATEFORME_ID, "SELECT traite_le FROM faits_recus WHERE tenant_id = $1 AND source = 'crm' AND event_id = $2 FOR UPDATE", [f.eventId]);
      return (r.rows[0] as { traite_le: Date | null } | undefined)?.traite_le === null;
    },
    async marquerTraite(eventId, resultat: ResultatFait) {
      await sous(PLATEFORME_ID, "UPDATE faits_recus SET traite_le = now(), resultat = $3 WHERE tenant_id = $1 AND source = 'crm' AND event_id = $2", [eventId, resultat]);
    },
    async organisationParCrm(crm) {
      const r = await equipe.query(`SELECT ${COLONNES_ORG} FROM organisations WHERE crm_company_id = $1 AND tenant_id <> $2 ORDER BY cree_le, id LIMIT 1`, [crm, PLATEFORME_ID]);
      return r.rows[0] ? lue(r.rows[0] as LigneOrg) : null;
    },
    async organisationsParSiren(siren) {
      const r = await equipe.query(`SELECT ${COLONNES_ORG} FROM organisations WHERE siren = $1 AND tenant_id <> $2 ORDER BY cree_le, id`, [siren, PLATEFORME_ID]);
      return (r.rows as LigneOrg[]).map(lue);
    },
    async lierCrm(orgId, crm) {
      await sous(orgId, "UPDATE organisations SET crm_company_id = $2 WHERE tenant_id = $1 AND id = $1", [crm]);
      await sous(orgId, "INSERT INTO liens_crm (tenant_id, id, organisation_id, crm_company_id) VALUES ($1, gen_random_uuid(), $1, $2) ON CONFLICT (tenant_id, crm_company_id) DO NOTHING", [crm]);
    },
    async rangerCopieCrm(orgId, copie) { await donnees(orgId, "copie", copie); },
    async proposerEcart(orgId, ecart) { await donnees(orgId, "ecart", ecart); },
    async noterApporteur(orgId, apporteurId) { await donnees(orgId, "apporteur", { apporteurId }); },
    async signalerATrancher(orgId, motif) {
      await sous(orgId ?? PLATEFORME_ID, "INSERT INTO a_trancher (tenant_id, id, organisation_id, source, motif, donnees_comparaison) VALUES ($1, gen_random_uuid(), $2, 'crm', $3, $4)", [orgId, motif, JSON.stringify({ eventId: eventCourant })]);
    },
    // La fiche garde son historique : l'ancien lien passe à « absorbé » (jamais supprimé), le lien de la fiche gardée devient le lien actif.
    async absorber(orgId, absorbee, gardee) {
      await sous(orgId, "INSERT INTO liens_crm (tenant_id, id, organisation_id, crm_company_id, etat, absorbe_par) VALUES ($1, gen_random_uuid(), $1, $2, 'absorbe', $3) ON CONFLICT (tenant_id, crm_company_id) DO UPDATE SET etat = 'absorbe', absorbe_par = EXCLUDED.absorbe_par", [absorbee, gardee]);
      await sous(orgId, "UPDATE organisations SET crm_company_id = $2 WHERE tenant_id = $1 AND id = $1", [gardee]);
      await sous(orgId, "INSERT INTO liens_crm (tenant_id, id, organisation_id, crm_company_id) VALUES ($1, gen_random_uuid(), $1, $2) ON CONFLICT (tenant_id, crm_company_id) DO NOTHING", [gardee]);
    },
    // Exclusion par (portée, empreinte), sans lire les contacts : un fait reçu avant l'import garde son effet. « * » = plateforme (opposition).
    async exclure(e: Exclusion) {
      await sous(PLATEFORME_ID, "INSERT INTO exclusions_c3 (tenant_id, id, portee, empreinte, genre) VALUES ($1, gen_random_uuid(), $2, $3, $4) ON CONFLICT (tenant_id, portee, empreinte) DO NOTHING", [e.genre === "opposition" ? "*" : e.crmCompanyId, e.empreinte, e.genre]);
    },
    async importerContacts(orgId, contacts) {
      for (const c of contacts) {
        await sous(orgId, "INSERT INTO contacts (tenant_id, id, organisation_id, nom, email) SELECT $1, gen_random_uuid(), $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE tenant_id = $1 AND organisation_id = $1 AND lower(email) = lower($3))", [c.nom, c.email]);
      }
    },
    async rangerAlertes(eventId, alertes: AlerteC3[]) {
      for (const a of alertes) {
        await sous(PLATEFORME_ID, "INSERT INTO alertes_c3 (tenant_id, id, event_id, type, reference) VALUES ($1, gen_random_uuid(), $2, $3, $4) ON CONFLICT (tenant_id, event_id, type, reference) DO NOTHING", [eventId, a.type, a.reference]);
      }
    },
    async alertesNonConfirmees(eventId) {
      const r = await sous(PLATEFORME_ID, "SELECT id, type, reference FROM alertes_c3 WHERE tenant_id = $1 AND event_id = $2 AND confirmee_le IS NULL ORDER BY cree_le, id", [eventId]);
      return (r.rows as { id: string; type: AlerteC3["type"]; reference: string }[]).map((x) => ({ id: x.id, alerte: { type: x.type, reference: x.reference } }));
    },
    async alertesEnAttente(limite) {
      const r = await sous(PLATEFORME_ID, "SELECT id, type, reference FROM alertes_c3 WHERE tenant_id = $1 AND confirmee_le IS NULL ORDER BY cree_le, id LIMIT $2", [limite]);
      return (r.rows as { id: string; type: AlerteC3["type"]; reference: string }[]).map((x) => ({ id: x.id, alerte: { type: x.type, reference: x.reference } }));
    },
    async confirmerAlerte(id) {
      await sous(PLATEFORME_ID, "UPDATE alertes_c3 SET confirmee_le = now() WHERE tenant_id = $1 AND id = $2 AND confirmee_le IS NULL", [id]);
    },
    async gardeeDe(crm) {
      const r = await equipe.query("SELECT absorbe_par FROM liens_crm WHERE crm_company_id = $1 AND etat = 'absorbe' AND tenant_id <> $2 ORDER BY id LIMIT 1", [crm, PLATEFORME_ID]);
      return (r.rows[0] as { absorbe_par: string } | undefined)?.absorbe_par ?? null;
    },
  };
}
