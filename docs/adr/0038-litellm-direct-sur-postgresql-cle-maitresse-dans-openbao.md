# 0038 · LiteLLM relié directement à PostgreSQL, clé maîtresse lue dans OpenBao

Date : 29/10/2026 · Statut : proposé (T1B-02, consigne ce qui est livré au lot 1-A ; relecture de l'architecte du lot demandée) · Contrat touché : aucun

## Contexte
Décision d'architecte n° 7 du sommaire du lot 1-A. La passerelle d'IA (LiteLLM) tient les clés virtuelles et les plafonds de dépense. Elle utilise des fonctions de base que PgBouncer en mode transaction n'accepte pas bien, et sa clé maîtresse ouvre toute la passerelle.

## Décision
- LiteLLM se connecte **directement** à PostgreSQL (base `passerelle_ia` de la grappe commune, ADR 0013), pas par PgBouncer (`general_settings.database_url` dans `ops/socle/litellm/config.yaml`).
- La clé maîtresse et les clés des fournisseurs ne sont dans aucun fichier du dépôt ni dans le compose : le point d'entrée du conteneur les lit dans OpenBao au démarrage.
- Aucun texte d'échange conservé : `turn_off_message_logging`, `store_prompts_in_spend_logs: false`, aucun cache, aucun rappel vers un service tiers.
- Les taux de prix du dépôt public sont **fictifs** (valeurs rondes sans rapport avec un vrai tarif) et marqués comme tels. Les vrais taux restent dans le dépôt privé (T1A-18).
- Le budget global journalier de la configuration est lui aussi fictif ; les seuils réels sont fixés au lot 8a (T1A-10).

## Conséquences
- Une seconde voie vers PostgreSQL à surveiller (nombre de connexions de la passerelle).
- Si la lecture dans OpenBao échoue (coffre scellé), la passerelle ne démarre pas : voulu.
- Les essais utilisent un faux fournisseur en `.test`, jamais un vrai.

Fiches : T1A-09 (passerelle, clés virtuelles, aucun journal de contenu), T1A-10 (plafonds de dépense), T1A-18 (relevé des prix, privé).
