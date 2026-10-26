# 0028 · Modèle de départ des modules et ligne de commande `axion-dev`

Date : 26/10/2026 · Statut : proposé (T4-08)

## Contexte
Écrire une automatisation doit rester aussi simple la centième fois que la deuxième. Règle C4 inchangée : un module = code commun versionné + réglages par client, jamais de code propre à un client.

## Décision
- `pnpm creer-module <code>` (script racine : `tsx packages/create-axion-module/src/index.ts`) copie un modèle (`packages/create-axion-module/gabarit/`, fichiers en `.modele`) dans `modules/<code>/`. Le code est validé par `defineAutomation` (même règle, aucun identifiant de client). Le modèle ne contient aucune logique métier ; tout ce qui varie d'un client passe par `reglages`.
- La forme `pnpm create` est écartée : pnpm la traduit en `pnpm dlx create-axion-module`, qui télécharge un paquet du registre npm (nom absent aujourd'hui, donc déposable par n'importe qui).
- `modules/*` rejoint l'espace de travail pnpm et les projets Vitest ; le modèle porte un `tsconfig.json` et un script `typecheck`.
- `axion-dev` (essai, test, emballer, publier) appelle le harnais (T4-05), l'emballage (T4-06) et le signataire de TEST (T4-07). Aucune clé de production.
- `publier --recette` est la seule sortie : adresse en `.test` ou adresse de recette lue dans la variable `AXION_RECETTE_ORIGINE` (origine, ex. `https://…`), requête signée HMAC (`commun/signature.ts`), re-signée à chaque essai avec la même `Idempotency-Key`. Sans `--recette`, refus (le catalogue se publie dans la console, T4-27).

## Conséquences
Codes de sortie stables : 0 réussi, 1 test échoué, 2 refus de l'emballage, 3 envoi refusé. Le modèle suit la version courante de C4 (`apiMoteur` `^0.2.0`) et sera mis à jour avec elle.
