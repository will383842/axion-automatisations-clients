import { ErreurModele, exigerModeleAdmis, MODELE_DEFAUT, MODELES_ADMIS, type ModeleAdmis } from "./modeles-admis.js";

// Choix du modèle d'IA (A-162, B-084, C-067, C-506) : la surcharge de l'instance, sinon le réglage du module, sinon le défaut du client, sinon Mistral.
// Le refus « hors UE » (registre_client.refus_transfert_hors_ue) s'applique au modèle FINAL, quelle qu'en soit l'origine : jamais de repli silencieux vers un autre modèle.
export type EntreeChoix = {
  refusHorsUe: boolean;
  defautClient: string | null;
  surcharge: string | null;
  reglageModule?: string | null;
  // ia.modelesAdmis du manifeste : si présent, le modèle choisi doit y figurer (attaque 4 : modèle déclaré par le module).
  modelesDuModule?: readonly string[];
  liste?: readonly ModeleAdmis[];
};

export function choisirModele(e: EntreeChoix): string {
  const liste = e.liste ?? MODELES_ADMIS;
  const code = e.surcharge ?? e.reglageModule ?? e.defautClient ?? MODELE_DEFAUT;
  const modele = exigerModeleAdmis(code, liste);
  if (e.refusHorsUe && modele.horsUe) throw new ErreurModele("hors_ue_refuse");
  if (e.modelesDuModule && !e.modelesDuModule.includes(modele.code)) throw new ErreurModele("hors_manifeste");
  return modele.code;
}
