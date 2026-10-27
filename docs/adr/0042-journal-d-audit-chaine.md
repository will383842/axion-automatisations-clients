# 0042 · Journal d'audit chaîné en base

Date : 27/10/2026 · Statut : proposé (T2-01a, maillon 1a de la chaîne C5 ; relecture en 2 tours par l'auditeur de sécurité) · Contrat touché : aucun (C5 reste en 0.4.0)

## Contexte
C5 (invariant 4) veut un journal d'audit en ajout seul et chaîné par hachage. Le port `JournalAudit` n'avait qu'une imitation en mémoire. La garde des migrations (ADR 0041) refuse toute fonction hors d'une liste fermée relue en 2 tours : les cinq fonctions ci-dessous y entrent avec ce numéro d'ADR.

## Décision
1. **Table `public.journal_audit`** (`0000_journal_audit.sql`, générée) : identité `GENERATED ALWAYS`, `tenant_id` facultatif (lignes de l'équipe sans client ; seule exception, `TENANT_FACULTATIF` de C5), acteur, action (énumération `action_audit`), entité, identifiant d'entité, anciennes et nouvelles valeurs en `jsonb`, adresse IP (`inet`), date, `empreinte_precedente`, `empreinte`. Index `(tenant_id, id)`. Aucune clé étrangère : une ligne d'audit survit à l'objet qu'elle décrit.
2. **RLS + FORCE** (`0001_journal_audit_fonctions.sql`, écrite à la main). `console_app` ne lit que son client (les lignes d'équipe lui sont cachées), `console_equipe` lit tout, le propriétaire (qui exécute les fonctions) a une politique d'écriture bornée au client actif et une politique de lecture, car FORCE s'applique aussi à lui. Droits : `SELECT` seulement pour `console_app` et `console_equipe`, aucun `INSERT`, `UPDATE`, `DELETE` ni `TRUNCATE` direct.
3. **Ajout seul** : déclencheur `BEFORE UPDATE OR DELETE` par ligne et `BEFORE TRUNCATE` par instruction, qui lèvent une erreur (`audit_refuser`), propriétaire compris. Les invariants C5 vérifient qu'ils sont actifs.
4. **Écriture** : `audit_ajouter` (`SECURITY DEFINER`, seule fonction ouverte à `console_app`) refuse une ligne dont le client n'est pas le client actif de la transaction (`app.tenant_id`), puis appelle `audit_inserer` (`SECURITY DEFINER`, fermée à tous sauf au propriétaire). `audit_inserer` prend un verrou consultatif de transaction, lit la dernière empreinte, tire l'identifiant dans la séquence et calcule `empreinte = sha256(empreinte_precedente || audit_contenu(ligne))`. Le verrou sérialise les écritures auditées (acceptable de 50 à 500 clients, à remesurer au lot 2b).
5. **Contenu canonique** (`audit_contenu`, pure) : tableau JSON `[id, tenant_id, acteur, action, entite, entite_id, ancienne, nouvelle, ip, date UTC ISO à la microseconde]` en texte. Les clés `jsonb` sont rangées par PostgreSQL de façon stable. T2-10 s'en sert pour vérifier la chaîne.
6. **Déclencheur d'audit des tables de client** (`audit_ecrire`) : SANS `SECURITY DEFINER`. Il appelle `audit_ajouter`, donc le contrôle du client actif s'applique aussi à lui, et il lit l'acteur et l'IP dans `app.acteur` et `app.ip`. Il n'est attaché à aucune table ici : T2-01b et les suivantes l'attachent à chaque table de client.
7. **Acteur et IP** : `avecClient(pool, tenantId, fn, { acteur, ip })` les pose par `set_config(..., true)` dans la transaction, jamais en session (PgBouncer en mode transaction). L'acteur fait de 1 à 128 caractères sans caractère de contrôle ; l'IP est validée par `net.isIP` (zone `%` refusée).
8. **Port** : `creerJournalAuditBase` (`journal-audit/base.ts`) écrit par `audit_ajouter` ; motif et montant (entier) vont dans `nouvelle`.
9. Chaque fonction `SECURITY DEFINER` porte un seul `SET search_path = pg_catalog, pg_temp` et des noms qualifiés `public.`.

## Risques acceptés et dettes
- Le journal en base contient légitimement des données de personnes (anciennes et nouvelles valeurs des lignes de client) et l'adresse IP de l'appelant (exigence A-178). Elles ne sont jamais recopiées dans le journal de l'API (Fastify, ouverture B). Leur rétention relève de T2-11. Le champ `motif` du port ne doit porter aucune donnée de personne.
- `audit_inserer` utilise `OVERRIDING SYSTEM VALUE` (l'identifiant entre dans l'empreinte, il doit donc être connu avant l'insertion). Ce SQL est dans une fonction relue et fermée au rôle applicatif ; la garde du code TypeScript évoquée dans l'ADR 0040 ne le voit pas, et n'a pas à le voir.
- Une écriture faite par le propriétaire de la base hors de ces fonctions (migration, `SET ROLE`) n'est pas calculée par la fonction : la vérification de la chaîne (T2-10) la détecte. Un propriétaire peut aussi désactiver un déclencheur ; les invariants le détectent.
- Une écriture de migration ou d'amorçage sur une table auditée, sans client actif, est refusée par `audit_ajouter` : ces écritures passent par `avecClient`.

## Conséquences
- Première migration réelle : le journal des migrations est `public.__migrations` (ADR 0041).
- T2-01b attache `audit_ecrire` à chaque table de client ; T2-10 vérifie la chaîne avec `audit_contenu`.
- Aucun workflow modifié.
