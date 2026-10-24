# 0003 · C1 sans route de pause ni de modification de plan

Date : 24/10/2026 · Statut : accepté

## Contexte
La porte C1 (console vers Hub de facturation) doit rester la plus étroite possible : elle ne peut ni émettre, ni supprimer, ni rembourser. Une pause ou une modification d'un plan récurrent ouvrirait des cas d'avoirs et de périodes partielles difficiles à auditer.

## Décision
C1 n'expose AUCUNE route de pause ni de modification d'un plan récurrent. Pour changer un plan : « clore puis recréer » (clôture avec date de fin et motif, puis création d'un nouveau plan). Les brouillons non émis sont signalés dans la réponse de clôture, jamais supprimés. Toute autre route → 403 `action_interdite` + alerte.

## Conséquences
- Moins de routes à sécuriser et à tester.
- La console gère le « clore puis recréer » côté client, avec une seule intention métier.
- Une demande de pause sera traitée comme une clôture suivie d'une création, jamais comme une nouvelle route.
