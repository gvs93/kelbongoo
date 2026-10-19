/**
 * rungis — Cloud Functions Kelbongoo V10.17 (v1.2, base de code séparée « rungis ») (19/10/2026) — projet Firebase distribkbg, région europe-west1
 * ---------------------------------------------------------------------------------------------
 * Fichier AUTONOME : ne modifie aucune fonction existante (kbgLogin, kbgClaimAdmin, kbgProxy…).
 *
 *  kbgRungisLogin : Espace Rungis. Connexion Google uniquement, adresse dans la liste blanche
 *                   (achat@probon.fr, gestion@probon.fr, hg@probon.fr). Pose le rôle kbRole:'rungis'
 *                   (sauf compte déjà master/admin : on n'y touche pas).
 *  kbgRungis      : passerelle vers l'Apps Script FL_Probon_Proxy pour 2 actions seulement :
 *                     rungis_cmd_get (commande 5h + rajouts)  → rôles rungis, admin
 *                     rungis_alert   (palette non récupérée)  → rôles pdp (chauffeur), rungis, admin
 *                   Le secret et l'URL /exec restent côté serveur (Secret Manager).
 *
 * Installation : dans Cloud Shell (compte hg@probon.fr), une seule ligne :
 *   bash <(curl -sL https://raw.githubusercontent.com/gvs93/kelbongoo/main/server/install_rungis.sh)
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const RUNGIS_EMAILS = ['achat@probon.fr', 'gestion@probon.fr', 'hg@probon.fr'];
const KBG_FL_EXEC_URL = defineSecret('KBG_FL_EXEC_URL');
const KBG_FL_SHARED_SECRET = defineSecret('KBG_FL_SHARED_SECRET');
const REGION = 'europe-west1';
// invoker 'private' : pas de liaison IAM « allUsers » (interdite par la règle d'organisation probon.fr) ;
// l'accès est ouvert ensuite par gcloud run … --no-invoker-iam-check (comme les autres fonctions).

const ALLOWED = {
  admin: ['rungis_cmd_get', 'rungis_alert'],
  rungis: ['rungis_cmd_get', 'rungis_alert'],
  pdp: ['rungis_alert'],
};
const cut = (v, n) => String(v == null ? '' : v).slice(0, n);

exports.kbgRungisLogin = onCall({ region: REGION, invoker: 'private' }, async (req) => {
  const t = req.auth && req.auth.token;
  if (!t) throw new HttpsError('unauthenticated', 'Connexion Google requise.');
  const provider = t.firebase && t.firebase.sign_in_provider;
  const email = String(t.email || '').toLowerCase();
  if (provider !== 'google.com' || t.email_verified !== true || !email) throw new HttpsError('permission-denied', 'Connexion Google requise.');
  const allowed = RUNGIS_EMAILS;
  if (!allowed.includes(email)) throw new HttpsError('permission-denied', 'Ce compte n\'a pas accès à l\'Espace Rungis.');
  const user = await admin.auth().getUser(req.auth.uid);
  const cur = user.customClaims || {};
  if (t.admin === true || cur.admin === true) return { ok: true, admin: true }; // compte master : inchangé
  await admin.auth().setCustomUserClaims(req.auth.uid, { kbRole: 'rungis', kbName: cut(t.name || email, 80) });
  return { ok: true, admin: false };
});

exports.kbgRungis = onCall({ region: REGION, invoker: 'private', secrets: [KBG_FL_EXEC_URL, KBG_FL_SHARED_SECRET], timeoutSeconds: 120 }, async (req) => {
  const t = req.auth && req.auth.token;
  if (!t) throw new HttpsError('unauthenticated', 'Connexion requise.');
  const role = t.admin === true ? 'admin' : String(t.kbRole || '');
  const d = req.data || {};
  const action = String(d.action || '');
  if (!(ALLOWED[role] || []).includes(action)) throw new HttpsError('permission-denied', 'Action non autorisée.');
  const a = d.alert || {};
  const payload = {
    secret: KBG_FL_SHARED_SECRET.value(),
    action,
    _role: role,
    _by: cut(t.kbName || t.name || t.email || '', 80),
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(d.day || '')) ? String(d.day) : '',
    alert: action === 'rungis_alert' ? {
      kind: a.kind === 'roll' ? 'roll' : 'enl', site: cut(a.site, 10), siteLabel: cut(a.siteLabel, 60), label: cut(a.label, 200),
      motif: cut(a.motif, 40), note: cut(a.note, 600), day: cut(a.day, 10), ref: cut(a.ref, 120),
    } : undefined,
  };
  let res;
  try {
    res = await fetch(KBG_FL_EXEC_URL.value(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
  } catch (e) { throw new HttpsError('unavailable', 'Apps Script injoignable.'); }
  const txt = await res.text();
  try { return JSON.parse(txt); } catch (e) { throw new HttpsError('unavailable', 'Réponse Apps Script invalide (déploiement ?) : ' + txt.slice(0, 120)); }
});
