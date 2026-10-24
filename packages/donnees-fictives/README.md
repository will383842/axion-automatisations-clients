# @axion-auto/donnees-fictives

Générateur déterministe de données INVENTÉES (même graine → même jeu) : SIREN et SIRET à clé de Luhn valide (jamais vérifiés auprès d'un registre), raisons sociales, personnes, e-mails `@exemple.fr` ou `*.test`, téléphones dans les plages de fiction (constante unique de `scripts/scanner-journaux.ts`), et le jeu de référence avec ses 7 pièges.

Usage : `genererJeuReference(graine)`. La garde `scripts/garde-donnees-reelles.ts` refuse toute donnée réelle dans le dépôt.

Limite connue : la garde est une analyse statique simple. Elle n'arrête pas les contournements volontaires (adresse coupée en morceaux, `&#64;` à la place de l'arobase, domaine accentué).
