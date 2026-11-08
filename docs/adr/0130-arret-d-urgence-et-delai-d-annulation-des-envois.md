# 0130 · Arrêt d'urgence et délai d'annulation des envois

Date : 07/11/2026 · Statut : accepté (accord de l'architecte, 08/11/2026 ; proposé par T4-18) · Contrat touché : aucun (C4 inchangé) · Migration : aucune · S'appuie sur : ADR 0102 (reprise des travaux), 0125 (instances)

## Contexte
- Le seul point d'envoi est l'appel du port `Connecteurs` dans le noyau, après l'écriture de l'intention. L'arrêt des envois existant (T4-22) vaut par instance et n'est relu qu'avant l'exécution.
- Une erreur qui n'est pas une `ErreurConnecteur` est classée définitive : la machine inscrit « echec » et le travail n'est plus jamais rejoué.

## Décision
1. **Garde d'envoi** : `garderConnecteurs` enveloppe le port `Connecteurs` d'un travail, dans `executerAvecMoteur`. Seule l'action `envoyer` est gardée. Ordre, tout avant l'appel : arrêt, ports présents, jeton du même client, destinataire du carnet du même client, annulation. Le noyau reste intact.
2. **Client de confiance** : `executerAvecMoteur` compare le client du travail (donnée modifiable dans Valkey) à celui de la configuration servie par la console, avant d'ouvrir journal et boîte. Écart : refus définitif `client_incoherent`, rien n'est écrit.
3. **Clés Valkey** (hors préfixe BullMQ) : `executeur:arret:global`, `executeur:arret:client:<UUID>`, `executeur:annulation:<executionId>`. Clé présente = arrêt posé, quelle que soit la valeur. L'exécuteur ne pose ni ne lève jamais un arrêt et ne supprime aucune clé : seule la console le fera. Le drapeau global vaut pour un Valkey : la console l'écrira dans chaque cellule.
4. **Sûr par défaut** : une lecture `MGET` à chaque envoi, sans cache, limitée à 1 s ; Valkey injoignable ou lent = refus. Port `Carnet` ou `ProprietaireJeton` absent = refus de tout envoi.
5. **Refus passagers** : `ArretEnvoisPose` et `EnvoiAnnule` sont des `ErreurConnecteur` de classe passagère. Le gestionnaire les reconnaît avant le compte des essais : arrêt = travail marqué `arrete` puis `UnrecoverableError` (gardé dans « failed », jamais supprimé, ni remis en attente seul) ; annulation = marqué `annule`, travail terminé sans échec. Une relance explicite (`job.retry()`) repart de l'intention écrite.
6. **Délai d'annulation de 10 s** tenu par la file (`delay`, `jobId` déterministe : un double clic = un travail). `SET … NX GET` atomique : `annule` (sans expiration) ou `parti` (7 jours) sont terminaux ; annuler après `parti` rend `trop_tard`.
7. **Adresse** : forme canonique (une arobase, minuscules, domaine en punycode, « +étiquette » gardé, nom affiché refusé) des deux côtés de la comparaison.

## Écarts à la fiche (accord de l'architecte)
- **E1** : les 4 tests de `s8-…test.ts` attendent 4 résultats différents d'un même appel `rejouer` et ne peuvent pas passer tels quels ; ils restent en `.fails` (dette confiée à T4-46, comme s6). La preuve est dans `tests/e2e/scenarios/c-534-message-envoye-par-erreur.test.ts` (faux Graph, connecteur Microsoft 365, puits SMTP). `apps/console/src/index.ts` n'est pas touché.
- **E2** : sans T4-35, un destinataire inconnu du client est refusé (`destinataire_hors_client`), pas mis en brouillon.

## Limite connue
Un arrêt survenu après l'écriture de l'intention laisse un connecteur `au_plus_une_fois` (IMAP) « à trancher » à la relance : sûr, un humain tranche. Garde avant l'intention = dette T4-45.

## Conséquences
- Ports réels `ProprietaireJeton` et `Carnet` et câblage dans le point d'entrée de l'exécuteur : T4-50e. Poser l'arrêt depuis la console : T3-27, T5-09, T6-12.
