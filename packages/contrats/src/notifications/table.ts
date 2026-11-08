// Table unique des envois automatiques (C-557) : aucun écran n'envoie un message absent d'ici.
// E-mail seulement en V1 ; le téléphone viendra en V2. Aucun envoi commercial automatique.

export type Destinataire = "administrateur_client" | "collegue_invite" | "will";
export type ModeEnvoi = "automatique" | "clic_will";

export interface Envoi {
  evenement: string;
  destinataire: Destinataire;
  canal: "email";
  mode: ModeEnvoi;
  interrupteur: string;
  // Clé du texte de l'e-mail dans messages/catalogue.ts (email.<evenement>), jamais dans messages.fr.ts.
  cleTexte: string | null;
  version: "V1" | "V2";
  exigence: string;
  // Conditions à vérifier juste avant l'envoi.
  conditions?: string[];
}

const e = (
  evenement: string,
  destinataire: Destinataire,
  mode: ModeEnvoi,
  exigence: string,
  cleTexte: string | null = null,
  conditions?: string[],
): Envoi => ({
  evenement,
  destinataire,
  canal: "email",
  mode,
  interrupteur: `envoi.${evenement}`,
  cleTexte,
  version: "V1",
  exigence,
  ...(conditions ? { conditions } : {}),
});

export const TABLE_ENVOIS: readonly Envoi[] = [
  e("invitationPortail", "administrateur_client", "automatique", "C-557", "email.invitationPortail"),
  e("invitationCollegue", "collegue_invite", "automatique", "C-557", "email.invitationCollegue"),
  e("cestParti", "administrateur_client", "automatique", "C-557, C-580", "email.cestParti"),
  e("lancementEnCours", "administrateur_client", "automatique", "C-557, C-580", "email.lancementEnCours"),
  e("lienReconnexion", "administrateur_client", "automatique", "C-577, C-603", "email.lienReconnexion", [
    "connexionTesteeEnEchec",
    "aucunIncidentOuvertSurConnecteur",
  ]),
  e("avisExpirationConnexion7Jours", "administrateur_client", "automatique", "C-557", "email.avisExpirationConnexion7Jours"),
  e("brouillonEnAttente", "administrateur_client", "automatique", "C-564", "email.brouillonEnAttente"),
  e("brouillonExpire", "administrateur_client", "automatique", "C-564", "email.brouillonExpire"),
  e("envoiEnAttenteARelire", "administrateur_client", "automatique", "C-605", "email.envoiEnAttenteARelire"),
  e("palier80Client", "administrateur_client", "automatique", "C-614", "email.palier80Client"),
  e("palier100Client", "administrateur_client", "automatique", "C-557, C-614", "email.palier100Client"),
  e("palier80Will", "will", "automatique", "C-614", "email.palier80Will"),
  e("palier100Will", "will", "automatique", "C-614", "email.palier100Will"),
  e("factureDisponible", "administrateur_client", "automatique", "C-557", "email.factureDisponible"),
  e("relanceImpaye", "administrateur_client", "clic_will", "C-557", "email.relanceImpaye"),
  e("nonPaiement30Jours", "administrateur_client", "clic_will", "C-558", "email.nonPaiement30Jours"),
  e("rapportMensuel", "administrateur_client", "automatique", "C-571", "email.rapportMensuel"),
  e("notificationViolation", "administrateur_client", "clic_will", "C-557, C-617", "email.notificationViolation"),
];

