# 0013 · Exception Trivy nommée et datée pour l'image d'essai whoami

Date : 25/10/2026 · Statut : accepté (à confirmer par l'architecte)

## Contexte
`garde-briques` échoue si un avis critique corrigeable a plus de 7 jours, ou un avis haut plus de 30 jours. L'image `traefik/whoami` v1.12.0 porte 10 avis dans la bibliothèque standard de Go. C'est le dernier tag publié : aucune version corrigée n'existe. Cette image est un écho de test, présent seulement dans `ops/socle/compose.zz-essai-routage.yml` (CI ou `SOCLE_ESSAI=1`). Elle n'est jamais déployée.

## Décision
Une clé optionnelle `exception_trivy` est admise dans un fichier de brique : `avis` (identifiants nommés), `adr`, `decidee_le`, `expire_le`, `motif`.
- Elle ne retire que les avis nommés, et seulement tant que `expire_le` n'est pas atteint (à la date du jour, UTC, elle est déjà tombée).
- Durée : 30 jours au plus. Elle expire d'elle-même : le passage nocturne de `garde-briques` redevient rouge.
- Le statut « essai » est déduit des composes, jamais déclaré : la brique doit être non livrée, citée par au moins un compose, et uniquement par des fragments `ops/socle/compose.zz-essai-*.yml`. Citée dans `compose.base.yml`, `ops/compose.test.yml` ou tout autre fragment : refusée.
- Le CLI `--trivy` revérifie tout cela avant d'appliquer l'exception.
- Aucun `.trivyignore`, aucun `--ignorefile`, `--skip-*`, `--ignore-unfixed` ni `--severity`. Les seuils ne changent pas. Des tests le gardent.

## Conséquences
- Les images de production (Keycloak, LiteLLM, PostgreSQL et les autres) n'ont droit à aucune exception.
- Un autre avis sur whoami fait échouer la garde.
- Renouvellement : nouvelle PR qui change les dates, avec accord du chef. Proposition : deux renouvellements au plus, puis une image d'écho maison.
- Avant le 24/11/2026 : remplacer whoami (nouveau tag publié, ou autre image d'écho).
