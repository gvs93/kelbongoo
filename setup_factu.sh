#!/bin/bash
# Prépare le codebase Firebase « facturation » (kbgFactuLog + kbgFacturerWeb), sans toucher aux autres fonctions.
set -e
B=https://raw.githubusercontent.com/gvs93/kelbongoo/transfert-kbfact
mkdir -p ~/kbg-facturation/functions && cd ~/kbg-facturation
cat > firebase.json <<'J'
{ "functions": [ { "source": "functions", "codebase": "facturation" } ] }
J
echo '{ "projects": { "default": "distribkbg" } }' > .firebaserc
cat > functions/package.json <<'J'
{ "name": "kbg-facturation", "private": true, "main": "index.js",
  "engines": { "node": "22" },
  "dependencies": { "firebase-admin": "^12.7.0", "firebase-functions": "^6.1.0" } }
J
curl -sfL "$B/kbgFactuLog.js?$(date +%s)" -o functions/index.js
node --check functions/index.js && grep -c '^exports\.' functions/index.js
cd functions && npm install --silent --no-audit --no-fund >/dev/null 2>&1 && echo "npm OK"
cd .. && echo "PRET : ~/kbg-facturation"; firebase projects:list 2>&1 | grep -i distribkbg || echo "firebase non connecté"
