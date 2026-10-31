#!/bin/bash
# Kelbongoo — mise à jour des fonctions facturation (+ kbgReglesCommandes) et du secret
cd ~/kbg-facturation || exit 1
curl -fsSL "https://raw.githubusercontent.com/gvs93/kelbongoo/transfert-kbfact/kbgFactuLog.js?$(date +%s)" -o functions/index.js || exit 1
grep -q kbgReglesCommandes functions/index.js && echo "1/4 code OK"
echo "2/4 Colle le secret du module kbfacturation (PrestaShop › Configurer), puis Entrée :"
firebase functions:secrets:set FACTU_LOG_SECRET
echo "3/4 Déploiement…"
firebase deploy --only functions:facturation --force
echo "4/4 Ouverture des fonctions à l'appli…"
for f in kbgfacturerweb kbgfactulog kbgreglescommandes; do
  gcloud run services update $f --region=europe-west1 --no-invoker-iam-check --project=distribkbg --quiet 2>&1 | tail -1
done
echo "PRET"
