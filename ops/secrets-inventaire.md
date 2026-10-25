# Inventaire des secrets (A-115)

Chaque secret est listé par son NOM, jamais par sa valeur. La garde `scripts/garde-secrets-inventaire.ts` refuse :
- une variable lue par un `apps/*/src/config.ts` ou un fragment `ops/socle/compose.*.yml` qui n'est pas inscrite ici ;
- un secret de catégorie `equipe` rangé sous `clients/`.

Catégories : `equipe` (outils et accès de l'équipe), `client` (secrets d'un client), `construction` (CI et essais, générés au lancement), `production`, `aucun` (variable lue qui n'est pas un secret).
Les secrets de l'équipe vivent dans Bitwarden ou sous `technique/` d'OpenBao, JAMAIS sous `clients/`.

## Variables lues par le code et le socle

| Nom | Catégorie | Lieu | Rotation |
|---|---|---|---|
| `NODE_ENV` | aucun | environnement cloud | sans objet |
| `PORT` | aucun | environnement cloud | sans objet |
| `APP_DATABASE_URL` | production | environnement cloud (le mot de passe vient d'OpenBao) | à chaque départ d'un administrateur |
| `HUB_URL` | aucun | environnement cloud | sans objet |
| `CRM_URL` | aucun | environnement cloud | sans objet |
| `DOMAINE_CONSOLE` | aucun | environnement de construction | sans objet |
| `DOMAINE_PORTAIL` | aucun | environnement de construction | sans objet |
| `DOMAINE_API` | aucun | environnement de construction | sans objet |
| `DOMAINE_SSO` | aucun | environnement de construction | sans objet |
| `SOCLE_CERTS` | construction | environnement de construction | générés à chaque lancement |
| `SOCLE_PG_MOT_DE_PASSE` | construction | environnement de construction | généré à chaque lancement |
| `SOCLE_VALKEY_MOT_DE_PASSE` | construction | environnement de construction | généré à chaque lancement |

## Secrets rangés dans OpenBao

| Nom | Catégorie | Lieu | Rotation |
|---|---|---|---|
| `clients/<client>/...` | client | OpenBao `clients/` | à la demande du client |
| `technique/echanges/<canal>/<kid>` | equipe | OpenBao `technique/` | deux clés actives, chevauchement de 24 h |
| `modules-signature` | equipe | OpenBao transit (clé non exportable) | sur décision de l'architecte |
| `PART` | equipe | Bitwarden et copie hors ligne, par rôle (voir la procédure) | au changement d'un détenteur |
| `JETON_ROLE_API` | production | environnement cloud | période de 768 h, à recréer avant l'échéance |
| `JETON_ROLE_SECOURS` | equipe | Bitwarden | recréé avant chaque échéance |
| `INSTANTANE_RAFT` | equipe | Bitwarden, séparé des parts | à chaque copie de secours |

## Secrets de la chaîne de déploiement

| Nom | Catégorie | Lieu | Rotation |
|---|---|---|---|
| `COOLIFY_JETON` | production | environnement GitHub réservé à `main` | chaque trimestre |
