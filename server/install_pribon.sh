#!/bin/bash
# Connexion unique Centrale · Console · Réception — installe la fonction pribonLogin (projet Firebase distribkbg).
# Base de code séparée « pribon » : ne touche à AUCUNE fonction existante (kbgLogin, kbgProxy, rungis…).
set -e
P=distribkbg
R=https://raw.githubusercontent.com/gvs93/kelbongoo/main/server
D=~/pribon-auth
echo "=== 0/5 Connexion Firebase"
if ! firebase projects:list >/dev/null 2>&1; then
  echo "Reconnexion nécessaire : ouvre le lien affiché, choisis ton compte propriétaire, autorise, puis colle le code ici."
  firebase login --reauth --no-localhost
fi
echo "=== 1/5 Préparation du dossier $D"
mkdir -p "$D/functions" && cd "$D"
printf '{\n  "functions": [ { "source": "functions", "codebase": "pribon" } ]\n}\n' > firebase.json
printf '{ "projects": { "default": "%s" } }\n' "$P" > .firebaserc
printf '{\n  "name": "pribon-auth",\n  "main": "index.js",\n  "engines": { "node": "22" },\n  "dependencies": { "firebase-admin": "^12.7.0", "firebase-functions": "^6.1.0" }\n}\n' > functions/package.json
curl -sfL "$R/pribon.js" -o functions/index.js
grep -q "pribonLogin" functions/index.js || { echo "Téléchargement du code impossible"; exit 1; }
echo "=== 2/5 Installation des modules (1 min)"
(cd functions && npm install --silent --no-audit --no-fund)
echo ""
echo "=== 3/5 Clés de service (fichiers .json téléversés dans Cloud Shell : ⋮ › Importer)"
for pair in "PRIBON_SA_PREP:kelbongoo-prep" "PRIBON_SA_ROB:robespierre-65cdf" "PRIBON_SA_BIC:bichat-80d62"; do
  S="${pair%%:*}"; PRJ="${pair##*:}"
  if gcloud secrets describe "$S" --project "$P" >/dev/null 2>&1; then echo "  $S déjà enregistrée ✔"; continue; fi
  F=$(ls -t ~/"$PRJ"-firebase-adminsdk-*.json 2>/dev/null | head -1)
  [ -n "$F" ] || { echo "❌ Fichier de clé introuvable pour $PRJ (attendu : ~/$PRJ-firebase-adminsdk-….json). Importe-le puis relance."; exit 1; }
  grep -q "\"project_id\": \"$PRJ\"" "$F" || { echo "❌ $F n'est pas une clé du projet $PRJ"; exit 1; }
  firebase functions:secrets:set "$S" --project "$P" --data-file "$F" >/dev/null
  rm -f "$F"
  echo "  $S enregistrée ✔ (fichier effacé de Cloud Shell)"
done
echo ""
if gcloud secrets describe PRIBON_REGISTRE_URL --project "$P" >/dev/null 2>&1; then echo "=== 4/5 URL du registre déjà enregistrée ✔"; else
echo "=== 4/5 Colle l'URL /exec de l'Apps Script PRIBON RECEPTION puis Entrée"
firebase functions:secrets:set PRIBON_REGISTRE_URL --project "$P"; fi
if ! gcloud secrets describe PRIBON_UID_PEPPER --project "$P" >/dev/null 2>&1; then
  T=$(mktemp); head -c 32 /dev/urandom | base64 | tr -d '\n' > "$T"
  firebase functions:secrets:set PRIBON_UID_PEPPER --project "$P" --data-file "$T" >/dev/null; rm -f "$T"; fi
echo ""
echo "=== 5/5 Déploiement (2-3 min)"
set +e
firebase deploy --only functions:pribon --project "$P"
echo "(Un message « Failed to set the IAM Policy » juste au-dessus est normal avec la règle de l'organisation.)"
gcloud run services update pribonlogin --region europe-west1 --no-invoker-iam-check --project "$P" --quiet
echo ""
gcloud run services describe pribonlogin --region europe-west1 --project "$P" --format='value(status.url)' || { echo "❌ Fonction absente : envoie la capture à Claude"; exit 1; }
echo "✅ Terminé. Copie l'adresse https://…run.app affichée juste au-dessus et envoie-la à Claude."
