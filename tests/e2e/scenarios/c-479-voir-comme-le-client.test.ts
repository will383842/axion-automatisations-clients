import { expect, test } from "vitest";
import { construireServeur } from "../../../apps/api/src/serveur.ts";
import { envoisServiceEnMemoire } from "../../../apps/api/src/envois/service.ts";
import { creerServiceDonnees, type PortsDonnees } from "../../../apps/api/src/donnees/service.ts";
import { creerRegistreVues } from "../../../apps/api/src/vue-client/ouvrir.ts";
import type { EntreeTrace } from "../../../apps/api/src/vue-client/trace.ts";

// Critère C-479 : « voir comme le client » est tracé et limité. Scénario de bout en bout sur bouchons (ports en mémoire, horloge injectée) ;
// à rejouer sur la recette (dette : spec/preuves/lot-3-t3-08a.md).
const A = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-11-07T10:00:00Z");

test("[C-479] voir comme le client tracé et limité", async () => {
  let t = T0.getTime();
  const maintenant = () => new Date(t);
  const registre = creerRegistreVues(maintenant);
  const envois = envoisServiceEnMemoire();
  const journal: EntreeTrace[] = [];
  let ecrituresAtteintes = 0;
  const ports: PortsDonnees = {
    base: async () => ({ nomBase: "cli_1111", etat: "active" }),
    ouvrir: async () => ({ requete: async (texte) => (texte.includes("commun.etablissements") ? [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] : [{ id: "x", nom: "Liste", cree_le: "t" }]), fermer: async () => {} }),
    accordValide: async () => true,
    vueRangee: (acteur, tenantId) => registre.vueRangee(acteur, tenantId),
    maintenant,
  };
  const service = creerServiceDonnees(ports);
  const equipe = async () => ({ acteur: "e1", roleEquipe: "administrateur" });
  const serveur = construireServeur({
    vueClient: {
      garde: { registre, acteur: async () => "e1" },
      exigerDroit: async () => {},
      equipe,
      vue: { accordValide: async () => true, finIntervention: async () => new Date(t + 7_200_000) },
      maintenant, envois,
      trace: { ecrire: async (e) => void journal.push(e) },
    },
    donnees: {
      session: async () => {
        const v = registre.vueDe("e1");
        return { tenantId: A, role: "equipe", acteur: "e1", etablissements: [], ...(v ? { vue: { tenantId: v.tenantId, expireLe: v.expireLe } } : {}) };
      },
      roleEquipe: async () => "administrateur",
      executer: (s, nom, p) => service.executer(s, nom, p),
    },
    notes: { ouvert: () => true, exigerEquipe: async () => {}, session: (() => { ecrituresAtteintes++; }) as never, lister: undefined as never, ajouter: (() => { ecrituresAtteintes++; }) as never, epingler: undefined as never, noterAppelEtClore: undefined as never },
  });
  await serveur.ready();
  const url = `/api/console/v1/clients/${A}/vue-client`;

  expect((await serveur.inject({ method: "POST", url, payload: { motif: "assistance" } })).statusCode).toBe(201);
  expect(envois.deposes.map((d) => d.type)).toEqual(["avis_vue_client_ouverte"]);
  expect((await serveur.inject({ method: "POST", url: "/api/v1/donnees/listerListesProspects", payload: {} })).statusCode).toBe(200);
  for (const page of ["fiche", "personnes"]) expect((await serveur.inject({ method: "POST", url: `${url}/pages`, payload: { page } })).statusCode).toBe(200);
  // Écrire pendant la vue : refusé, rien n'atteint la route d'écriture.
  const ecriture = await serveur.inject({ method: "POST", url: `/api/console/v1/clients/${A}/notes`, payload: { texte: "essai" } });
  expect(ecriture.statusCode).toBe(403);
  expect(ecrituresAtteintes).toBe(0);
  // Minute 60 : la vue est fermée côté serveur, la lecture du contenu est refusée.
  t += 3_600_000;
  expect((await serveur.inject({ method: "POST", url: "/api/v1/donnees/listerListesProspects", payload: {} })).statusCode).toBe(403);
  expect((await serveur.inject({ method: "POST", url: `${url}/pages`, payload: { page: "fiche" } })).statusCode).toBe(404);
  expect(journal.map((e) => e.evenement + (e.page ? `:${e.page}` : ""))).toEqual(["vue_client_ouverte", "page_consultee:fiche", "page_consultee:personnes"]);
  await serveur.close();
});
