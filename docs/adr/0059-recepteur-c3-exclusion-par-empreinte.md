# 0059 · Récepteur C3 : exclusion durable par empreinte, alertes rejouables, liens CRM

Date : 02/11/2026 · Statut : proposé (T2-17) · Contrat touché : aucun · Migration : aucune (la fiche l'interdit).

## Contexte
Le récepteur C3 range les faits signés du CRM. Règle de Will : une opposition (consentement retiré, effacement demandé) met à l'écart des envois, **durablement** ; les données sont gardées ; aucun contact n'est supprimé.

## Décision
1. **Exclusion par empreinte, sans lecture des contacts.** Le port `exclure` range `(portée, empreinte)`. Il ne dépend d'aucun contact : un fait reçu avant l'import garde son effet, et un import ultérieur retrouve l'exclusion. Idempotent.
2. **Portée.** `consentement.retire` (genre « désabonnement ») est propre au client du sujet (`subject_ref.crmCompanyId`) ; l'exclusion suit la fiche après une fusion (fiche gardée ou absorbée). `effacement.demande` (genre « opposition ») est **globale à la plateforme** : elle vaut pour tous les clients. Choix à confirmer par Will : le contrat C3 n'a pas de champ « genre », je le déduis du type de fait.
3. **Alertes dans la transaction.** Les alertes sont rangées dans la même transaction que le fait (`rangerAlertes`), envoyées après validation, puis confirmées une à une. Un envoi qui échoue laisse l'alerte non confirmée ; un doublon du même fait rejoue les alertes non confirmées (au moins une fois, jamais perdues).
4. **Lien CRM jamais remplacé.** `devenue_cliente` : si `subject_ref.crmCompanyId` diffère de celui du contenu, le fait est « à trancher » (`identifiant_crm_incoherent`), rien n'est lié. Si la fiche du SIREN porte déjà un lien vers un autre `crmCompanyId`, le lien reste, un écart `lien_crm` est proposé et le fait est « à trancher » (`lien_crm_different`).
5. **File sans donnée de personne.** La route retire `contacts` (nom, e-mail) du job et borne la conservation (7 jours, terminés et en échec).

## Conséquences
Aucun changement de contrat. Le dépôt en mémoire prouve les règles ; l'adaptateur SQL (T2-17b) les reprend.

## Dettes
Propriétaire de toutes : **T2-17b** (fiche OUVERTE, non créée ici : adaptateur SQL du dépôt C3).
- **Tables de l'adaptateur** : exclusions par (portée, empreinte), boîte d'alertes (id, fait, alerte, confirmée), contacts importés. Critère de test : un essai `*.int.test.ts` reprend les tests [C-458] (retrait avant import, portée, fusion, rejeu des alertes, atomicité) sur la vraie base.
- **Contacts du fait `devenue_cliente`** : retirés du job, donc non rangés tant que l'adaptateur ne les écrit pas avant la mise en file. Critère de test : un fait signé range les contacts en base et le job ne les contient pas.
