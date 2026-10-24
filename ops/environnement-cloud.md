# Environnement cloud « axion-auto » (à recréer après un changement de compte)

Aucune valeur secrète dans ce fichier : seulement des noms.

## Nom
`axion-auto`, créé sur le compte réservé à la console.

## Réseau permis (rien d'autre)
- npm ;
- GitHub, dont `ghcr.io` ;
- Docker Hub ;
- `quay.io` (images Keycloak) ;
- le CDN de téléchargement des navigateurs de Playwright ;
- la documentation des outils.

Aucune clé de production dans l'environnement.

## Variables (noms seulement)
- `NOMS_CLIENTS` (secrète, une raison sociale par ligne) : même nom que le secret du dépôt privé.

## Commande d'installation
`corepack enable && pnpm install --frozen-lockfile`

## Services de test
`bash ops/sonde-services.sh` lance (si les conteneurs existent) puis vérifie les 7 services de `ops/compose.test.yml` : PostgreSQL 16, PgBouncer (mode transaction), Valkey, OpenBao (dev), Keycloak (dev), LiteLLM (sans clé réelle), Mailpit. Pour chacun : « démarré » ou « impossible ».

### Constat du premier essai (session cloud)
- Le démon de conteneurs est absent : aucun des 7 services n'a démarré par conteneur.
- Présents sur la machine : binaires PostgreSQL 16 (impossibles à lancer en super-utilisateur : la sonde ne les lance que sous un compte normal) et `redis-server` 7.0 (ce n'est pas Valkey : non retenu comme substitut).
- Absents : PgBouncer, Valkey, OpenBao, Keycloak, LiteLLM, Mailpit.

### Parade
- PostgreSQL et Valkey : binaires installés par le gestionnaire de paquets quand ils existent.
- Les autres : imitations à contrat identique, écrites au lot 1. Rien n'est inventé ici.
- Les versions d'images de `compose.test.yml` sont épinglées mais n'ont pas pu être téléchargées : à confirmer là où les conteneurs existent (CI, T0-12).

### Écarts connus
- LiteLLM : aucune configuration n'est montée, donc seule la vivacité du service est vérifiée ; le modèle factice (sans clé) reste à ajouter par la fiche qui touchera la configuration.
- `ops/sonde-services.test.sh` n'est lancé par aucun contrôle : le job de CI (un job = un fichier `.github/workflows/<job>.yml`) reste à écrire par la fiche concernée.
