# Sonde extérieure (T5-12b)

## À retenir
Une sonde posée sur le même serveur que la plateforme n'est **pas** une sonde extérieure : si le serveur tombe, la sonde tombe avec lui et personne n'est prévenu. La sonde doit tourner **hors du serveur unique**.

## Où l'installer (lot 8a)
- Une seconde instance d'Uptime Kuma, chez un autre hébergeur que le serveur de la plateforme.
- Elle vise la page publique `https://statut.axion-ia.com/` (domaine décidé en E5-D5). Le vrai DNS est posé au lot 8a ; pendant la construction, aucun serveur permanent n'existe.
- Quand la page ne répond plus, elle envoie le signal « injoignable » à `POST /api/public/v1/sonde`.

## Le signal
- Corps : `{"etat":"injoignable"}`.
- En-têtes : `x-axion-horodatage` (secondes depuis 1970) et `x-axion-signature` (HMAC-SHA256 en hexadécimal de `<horodatage>.<corps>`).
- La clé est rangée dans OpenBao (canal « sonde ») ; elle n'est écrite dans aucun fichier du dépôt. La rotation suit celle des clés d'échange.
- Un signal non signé, mal signé ou vieux de plus de 5 minutes reçoit 401 et n'ouvre rien. Un autre état (`ok`) est reçu sans ouvrir d'incident.
- Un signal valide ouvre l'incident critique `plateforme_injoignable` (suivi en T5-08).

## Comment la tester
1. Envoyer un signal non signé : attendre 401.
2. Envoyer un signal signé avec `{"etat":"ok"}` : attendre 200, aucun incident.
3. Envoyer un signal signé avec `{"etat":"injoignable"}` : attendre 200 et un incident critique dans la console.
4. Couper volontairement la page publique 2 minutes : la sonde doit déclencher le même incident seule.
