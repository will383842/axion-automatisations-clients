#!/bin/sh
# Point d'entrée de la passerelle (C-598 d) : lit la clé maîtresse et les clés des fournisseurs dans OpenBao
# (politique « passerelle », jeton court dans un fichier), les met dans l'environnement DU PROCESSUS seulement, puis lance LiteLLM.
# OpenBao scellé, injoignable ou incomplet : arrêt en erreur, sans repli. Aucune valeur n'est écrite, affichée ni passée en argument.
set -eu
: "${BAO_ADDR:?adresse d'OpenBao absente}" "${BAO_JETON_FICHIER:?fichier du jeton absent}"
exec python3 -I - "$@" <<'PYTHON'
import json, os, sys, urllib.request

class SansRedirection(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None

def arret(raison):
    print("passerelle : " + raison, file=sys.stderr)
    sys.exit(1)

def lire(chemin, jeton):
    requete = urllib.request.Request(os.environ["BAO_ADDR"] + "/v1/passerelle/data/" + chemin, headers={"X-Vault-Token": jeton})
    try:
        with urllib.request.build_opener(SansRedirection).open(requete, timeout=5) as r:
            donnees = json.load(r)["data"]["data"]
    except Exception:
        arret("OpenBao inaccessible, scellé ou secret absent : " + chemin)
    if not isinstance(donnees, dict) or not all(isinstance(v, str) and v for v in donnees.values()) or not donnees:
        arret("secret vide ou mal formé : " + chemin)
    return donnees

if "LITELLM_MASTER_KEY" in os.environ or any(n.startswith("FOURNISSEUR_") for n in os.environ):
    arret("une clé est déjà dans l'environnement de déploiement : refusé")
try:
    with open(os.environ["BAO_JETON_FICHIER"]) as f:
        jeton = f.read().strip()
except OSError:
    arret("fichier du jeton illisible")
if not jeton:
    arret("jeton vide")

maitre = lire("maitre", jeton).get("cle")
fournisseurs = lire("fournisseurs", jeton)
if not maitre:
    arret("clé maîtresse absente")
if not all(n.startswith("FOURNISSEUR_") and len(n) > 12 and n.isupper() and n.replace("_", "").isalnum() for n in fournisseurs):
    arret("nom de variable refusé dans les clés des fournisseurs")

for n in ("BAO_ADDR", "BAO_JETON_FICHIER"):
    del os.environ[n]
os.environ.update(fournisseurs)
os.environ["LITELLM_MASTER_KEY"] = maitre
os.execvp("litellm", ["litellm", "--config", os.environ.get("PASSERELLE_CONFIG", "/etc/litellm/config.yaml"), "--port", "4000"])
PYTHON
