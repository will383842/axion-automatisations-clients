import { describe, expect, it } from "vitest";
import { empreinteDe, type LigneJournal } from "./contenu-canonique.js";
import { verifierChaine, type LecteurJournal } from "./verifier.js";

// Vérification de la chaîne (T2-10), sans base : le lecteur est une imitation qui sert les lignes par lots.
function chaine(n: number, depart: { id: number; empreinte: string | null } = { id: 0, empreinte: null }): LigneJournal[] {
  const lignes: LigneJournal[] = [];
  let precedente = depart.empreinte;
  for (let i = 1; i <= n; i++) {
    const l: LigneJournal = {
      id: String(depart.id + i), tenant_id: i % 2 ? "11111111-1111-4111-8111-111111111111" : null, acteur: "agent-essai", action: "insertion", entite: "contacts", entite_id: `c${i}`,
      ancienne: null, nouvelle: `{"v": ${i}}`, ip: i % 3 ? "192.0.2.17" : null, cree: `2026-10-31T10:00:00.${String(i).padStart(6, "0")}Z`, empreinte_precedente: precedente, empreinte: "",
    };
    l.empreinte = empreinteDe(precedente, l);
    precedente = l.empreinte;
    lignes.push(l);
  }
  return lignes;
}
function lecteurDe(lignes: LigneJournal[]): LecteurJournal & { lots: number } {
  const lecteur = {
    lots: 0,
    async lireLot(apres: string | null, limite: number) {
      lecteur.lots++;
      return lignes.filter((l) => apres === null || BigInt(l.id) > BigInt(apres)).slice(0, limite);
    },
    async lireIntervalle(debut: string, fin: string) {
      return lignes.filter((l) => l.cree >= debut && l.cree < fin);
    },
  };
  return lecteur;
}

describe("verifierChaine", () => {
  it("[C-028] la vérification d'un journal intact ne trouve aucune rupture", async () => {
    const r = await verifierChaine(lecteurDe(chaine(25)));
    expect(r).toMatchObject({ intacte: true, lignes: 25 });
  });

  it("[C-028] une ligne modifiée est trouvée à son identifiant, avec l'empreinte attendue et celle trouvée", async () => {
    const lignes = chaine(25);
    const vraie = lignes[11]!.empreinte;
    lignes[11] = { ...lignes[11]!, acteur: "forge" };
    const r = await verifierChaine(lecteurDe(lignes));
    expect(r).toMatchObject({ intacte: false, rupture: { id: "12", trouve: vraie } });
    if (!r.intacte) expect(r.rupture.attendu).not.toBe(vraie);
  });

  it("[C-028] une ligne retirée est trouvée sur la ligne suivante, un trou d'identifiants sans retrait est accepté", async () => {
    const lignes = chaine(10);
    const sans = lignes.filter((l) => l.id !== "5");
    expect(await verifierChaine(lecteurDe(sans))).toMatchObject({ intacte: false, rupture: { id: "6", attendu: lignes[3]!.empreinte, trouve: lignes[4]!.empreinte } });
    // Un trou laissé par une transaction annulée : les identifiants sautent, la chaîne reste juste (ADR 0042).
    const trou = [...chaine(4), ...chaine(3, { id: 9, empreinte: chaine(4)[3]!.empreinte })];
    expect(await verifierChaine(lecteurDe(trou))).toMatchObject({ intacte: true, lignes: 7 });
  });

  it("[C-028] le journal se lit par lots de 1 000 dans l'ordre", async () => {
    const lecteur = lecteurDe(chaine(2500));
    const r = await verifierChaine(lecteur);
    expect(r).toMatchObject({ intacte: true, lignes: 2500 });
    expect(lecteur.lots).toBe(3);
  });

  it("[C-028] depuis une tête déjà vérifiée, seule la suite est lue ; une tête qui ne correspond pas est une rupture", async () => {
    const lignes = chaine(30);
    const tete = { id: lignes[19]!.id, empreinte: lignes[19]!.empreinte };
    expect(await verifierChaine(lecteurDe(lignes), tete)).toMatchObject({ intacte: true, lignes: 10 });
    expect(await verifierChaine(lecteurDe(lignes), { id: tete.id, empreinte: "0".repeat(64) })).toMatchObject({ intacte: false, rupture: { id: "21", attendu: "0".repeat(64), trouve: lignes[19]!.empreinte } });
  });
});
