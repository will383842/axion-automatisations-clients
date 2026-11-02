# 0106 · Récepteur C3 : exclusion durable par empreinte, alertes rejouables, liens CRM

Date : 02/11/2026 · Statut : proposé (T2-17, complété par T2-17b) · Contrat touché : aucun · Migration : aucune pour T2-17 ; console 0015 pour T2-17b (numéro réservé dans le dépôt privé).

## Contexte
Le récepteur C3 range les faits signés du CRM. Règle de Will : une opposition (consentement retiré, effacement demandé) met à l'écart des envois, **durablement** ; les données sont gardées ; aucun contact n'est supprimé.

## Décision
1. **Exclusion par empreinte, sans lecture des contacts.** Le port `exclure` range `(portée, empreinte)`. Il ne dépend d'aucun contact : un fait reçu avant l'import garde son effet, et un import ultérieur retrouve l'exclusion. Idempotent.
2. **Portée.** `consentement.retire` (genre « désabonnement ») est propre au client du sujet (`subject_ref.crmCompanyId`) ; l'exclusion suit la fiche après une fusion (fiche gardée ou absorbée). `effacement.demande` (genre « opposition ») est **globale à la plateforme** : elle vaut pour tous les clients. Choix à confirmer par Will : le contrat C3 n'a pas de champ « genre », je le déduis du type de fait.
3. **Alertes dans la transaction.** Les alertes sont rangées dans la même transaction que le fait (`rangerAlertes`), envoyées après validation, puis confirmées une à une. Un envoi qui échoue laisse l'alerte non confirmée ; un doublon du même fait rejoue les alertes non confirmées (au moins une fois, jamais perdues).
4. **Lien CRM jamais remplacé.** `devenue_cliente` : si `subject_ref.crmCompanyId` diffère de celui du contenu, le fait est « à trancher » (`identifiant_crm_incoherent`), rien n'est lié. Si la fiche du SIREN porte déjà un lien vers un autre `crmCompanyId`, le lien reste, un écart `lien_crm` est proposé et le fait est « à trancher » (`lien_crm_different`).
5. **File sans donnée de personne.** La route retire `contacts` (nom, e-mail) du job et borne la conservation (7 jours, terminés et en échec).

## Adaptateur SQL (T2-17b)
1. **Fait rangé avant la file.** La route valide, range le fait complet en base (`faits_recus` + `contenus_c3`, idempotent), puis met en file un job qui ne porte que `{ tenantId, eventId }`. Si la file refuse, le fait reste rangé et le rejeu du CRM ne le range pas deux fois. Séquence bornée à 2^53-1.
2. **Contacts.** Le contenu rangé garde les contacts du fait « devenue cliente » ; la liaison les range dans `contacts` de la fiche liée (une ligne par e-mail), jamais dans Valkey.
3. **Exclusions.** Table `exclusions_c3` : unicité `(tenant_id, portee, empreinte)`, portée « * » pour l'opposition (plateforme), identifiant CRM du client pour le désabonnement ; insertion seule, aucun droit de suppression. L'envoi commercial lit cette liste par `estExclue` (fiche CRM actuelle ou absorbée du client).
4. **Alertes.** Table `alertes_c3`, confirmation une à une. Un `signaler` qui lève ne fait plus échouer la tâche (pas d'essai BullMQ de plus : le fait est déjà traité) ; le balayage `balayerAlertes` renvoie les alertes non confirmées.
5. **Essais BullMQ fixés** : 5, attente exponentielle de 2 s. La transaction du fait est atomique, un nouvel essai est sans risque.
6. **Lectures entre clients** (fiche par identifiant CRM ou SIREN) par le pool `console_equipe`, en lecture seule ; écritures par `console_app`, client actif changé par instruction (`set_config` local). Un seul travailleur à la fois (concurrence 1) : deux faits d'une même fiche ne se doublent pas.
7. **Portée des exclusions** (décision d'architecte demandée par la fiche, que la fiche appelle « ADR 0059 » avant le renommage de #144) : retrait de consentement = client du sujet ; effacement = plateforme. Will la relit à la relecture finale des textes juridiques.

## Conséquences
Aucun changement de contrat. Le dépôt en mémoire et l'adaptateur SQL passent les mêmes règles (essais `*.int.test.ts` sur la vraie base).

## Dettes
Propriétaire : la fiche OUVERTE nommée dans chaque ligne de `spec/preuves.md` (dette groupée `LOT2-dette-T2-17b-reste`).
