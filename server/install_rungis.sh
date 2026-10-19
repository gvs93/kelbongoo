#!/bin/bash
# Kelbongoo — installation des fonctions Espace Rungis (kbgRungisLogin + kbgRungis), projet Firebase distribkbg.
# Base de code séparée « rungis » : ne touche à AUCUNE fonction existante (kbgLogin, kbgProxy…).
set -e
P=distribkbg
R=https://raw.githubusercontent.com/gvs93/kelbongoo/main/server
D=~/kbg-rungis
echo "=== 0/5 Connexion Firebase"
if ! firebase projects:list >/dev/null 2>&1; then
  echo "Reconnexion nécessaire : ouvre le lien affiché, choisis hg@probon.fr, autorise, puis colle le code ici."
  firebase login --reauth --no-localhost
fi
echo "=== 1/5 Préparation du dossier $D"
mkdir -p "$D/functions" && cd "$D"
printf '{\n  "functions": [ { "source": "functions", "codebase": "rungis" } ]\n}\n' > firebase.json
printf '{ "projects": { "default": "%s" } }\n' "$P" > .firebaserc
printf '{\n  "name": "kbg-rungis",\n  "main": "index.js",\n  "engines": { "node": "20" },\n  "dependencies": { "firebase-admin": "^12.7.0", "firebase-functions": "^6.1.0" }\n}\n' > functions/package.json
curl -sfL "$R/rungis.js" -o functions/index.js
grep -q "kbgRungisLogin" functions/index.js || { echo "Téléchargement du code impossible"; exit 1; }
echo "=== 2/5 Installation des modules (1 min)"
(cd functions && npm install --silent --no-audit --no-fund)
echo ""
echo "=== 3/5 Colle l'URL /exec de FL_Probon_Proxy puis Entrée"
firebase functions:secrets:set KBG_FL_EXEC_URL --project "$P"
echo ""
echo "=== 4/5 Colle le SHARED_SECRET de FL_Probon_Proxy puis Entrée"
firebase functions:secrets:set KBG_FL_SHARED_SECRET --project "$P"
echo ""
echo "=== 5/5 Déploiement (2-3 min)"
firebase deploy --only functions:rungis --project "$P"
gcloud run services update kbgrungislogin --region europe-west1 --no-invoker-iam-check --project "$P" --quiet
gcloud run services update kbgrungis --region europe-west1 --no-invoker-iam-check --project "$P" --quiet
echo ""
echo "✅ Terminé : achat@ et gestion@ peuvent ouvrir l'Espace Rungis (camion Rungis › Espace Rungis)."
