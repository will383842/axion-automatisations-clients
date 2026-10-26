# axion-dev

Ligne de commande de l'équipe qui écrit des automatisations. À lancer dans `modules/<code>/`.

1. `axion-dev essai --cas <nom>` joue un seul cas du jeu d'essai : étapes, effets demandés, brouillons.
2. `axion-dev test` lance tout le harnais (jeu d'essai, e-mails piégés, déterminisme, IA hostile).
3. `axion-dev emballer` construit l'artefact (garde de l'emballage) puis le signe avec la clé de TEST.
4. `axion-dev publier --recette` envoie l'artefact signé à l'import de la recette.
5. `AXION_RECETTE_URL` doit viser un nom en `.test` ou à l'origine écrite dans `AXION_RECETTE_ORIGINE` (configuration de la recette).
6. `AXION_RECETTE_SECRET` signe la requête (HMAC, `commun/signature.ts`) ; chaque essai est re-signé, même `Idempotency-Key`.
7. Sans `--recette`, `publier` est refusé : la publication au catalogue se fait dans la console.
8. Codes de sortie : 0 réussi, 1 test échoué, 2 refus de l'emballage, 3 envoi refusé.
9. Aucune commande n'envoie quoi que ce soit hors de la recette.
10. Le module attendu exporte son manifeste (`defineAutomation`) dans `src/module.ts`.
