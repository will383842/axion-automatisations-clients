# 0102 · Reprise et anti-doublon branchés sur la base moteur

Date : 01/11/2026 · Statut : proposé (T4-17, aucune migration) · Contrat touché : aucun · Relecture : envois, 1 tour

## Contexte
Le noyau (T4-02) écrit ses intentions et son journal par des ports en mémoire. Après un arrêt brutal, tout était perdu. La base `moteur` (ADR 0101) a déjà les tables `journal_etape`, `intentions` et `curseurs`.

## Décision
1. **Une classe par port**, pour un seul client (le `tenant_id` est posé par `avecClient`, la RLS reste forcée) : `JournalPostgres`, `BoitePostgres`, `CurseursPostgres`. Chaque méthode est une transaction terminée à son retour : l'intention est donc validée AVANT l'appel du connecteur. Si la transaction échoue, le connecteur n'est pas appelé.
2. **Aucune migration** : les colonnes manquantes sont absorbées sans toucher aux tables. Le statut « a_trancher » et l'essai du journal tiennent dans la clé `<statut>-<essai>` (liste fermée, pas de texte libre). L'étape naît `en_cours` (politique d'insertion) puis passe à son état final dans la même transaction.
3. **Reprise** : le journal relu saute les étapes faites. Une intention `ecrite` sans issue suit la garantie du connecteur : même clé, vérification après coup, ou « à trancher » sans renvoi.
4. **Attentes BullMQ** : le délai d'un nouvel essai est calculé par la politique des erreurs (`planifierReprise`), jamais par l'option `backoff`. Plafond de 5 essais pour `passagere`. Une erreur d'identification met l'instance en pause.

## Conséquences (dettes)
- **Bail non partagé** : la table `intentions` n'a pas de colonne de bail. Le bail ne vaut que dans le processus ; entre deux travailleurs, seule la garantie du connecteur protège (jamais de renvoi à l'aveugle). Un bail partagé demande une colonne : migration à décider avec l'architecte.
- `lire(cle)` rend des détails d'appel vides pour une intention écrite par un autre processus (la table ne les garde pas).
- Le marquage « faite » de l'intention et l'inscription de l'étape sont deux transactions (deux ports) ; la reprise reste sûre, car l'intention « faite » n'est pas rappelée.
- `securiserPartitions` doit être appelée après toute migration (dette de l'ADR 0101).
