#!/bin/bash
# Inspection (lecture seule) du projet Firebase dans Cloud Shell
cd ~
D=$(dirname "$(find ~ -maxdepth 3 -name firebase.json -not -path '*/node_modules/*' | head -1)")
echo "DIR=$D"; cd "$D" || exit 1
ls; echo ---; cat firebase.json; echo ---
grep -n '"node"\|engines\|firebase-functions"\|firebase-admin"' functions/package.json
echo --- exports; grep -n '^exports\.' functions/index.js | head -40
echo --- rules; R=$(grep -o '"rules": *"[^"]*"' firebase.json | head -1 | sed 's/.*: *"//;s/"//'); echo "RULES=$R"; wc -l "$R" 2>/dev/null
grep -n 'function isAdmin\|function isMaster\|token.admin\|match /{document=\*\*}\|match /facturation\|match /pdv_' "$R" | head -20
echo --- secrets; firebase --version; firebase functions:secrets:get FACTU_LOG_SECRET 2>&1 | tail -2
