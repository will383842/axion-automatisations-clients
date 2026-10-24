# @axion-auto/donnees-fictives

Générateur déterministe de données INVENTÉES (même graine → même jeu) : SIREN et SIRET à clé de Luhn valide (jamais vérifiés auprès d'un registre), raisons sociales, personnes, e-mails `@exemple.fr` ou `*.test`, téléphones dans les plages de fiction (constante unique de `scripts/scanner-journaux.ts`), et le jeu de référence avec ses 7 pièges.

Usage : `genererJeuReference(graine)`. La garde `scripts/garde-donnees-reelles.ts` refuse toute donnée réelle dans le dépôt.
