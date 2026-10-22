/**
 * rungis — Cloud Functions Kelbongoo V10.40 (v1.3, base de code séparée « rungis ») (22/10/2026) — projet Firebase distribkbg, région europe-west1
 * ---------------------------------------------------------------------------------------------
 * Fichier AUTONOME : ne modifie aucune fonction existante (kbgLogin, kbgClaimAdmin, kbgProxy…).
 *
 *  kbgRungisLogin : Espace Rungis. Connexion Google uniquement, adresse dans la liste blanche
 *                   (achat@probon.fr, gestion@probon.fr, hg@probon.fr). Pose le rôle kbRole:'rungis'
 *                   (sauf compte déjà master/admin : on n'y touche pas).
 *  kbgRungis      : passerelle vers l'Apps Script FL_Probon_Proxy pour ces actions seulement :
 *                     rungis_cmd_get (commande 4h30 + rajouts)  → rôles rungis, admin
 *                     rungis_alert   (palette non récupérée)    → rôles pdp (chauffeur), rungis, admin
 *                     v1.3 — contrôle du BL Rungis (KBG_BL.gs) → rôles rungis, admin :
 *                       rungis_bl_check (PDF base64 ≤ 6 Mo), rungis_bl_list, rungis_bl_concord, rungis_bl_recheck
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
// Règle d'organisation probon.fr : le déploiement ne peut pas poser « allUsers » (message « Failed to set the IAM Policy »,
// sans gravité) ; l'accès est ouvert par gcloud run … --no-invoker-iam-check (comme kbgLogin, kbgProxy…).

const BL_ACTIONS = ['rungis_bl_check', 'rungis_bl_list', 'rungis_bl_concord', 'rungis_bl_recheck'];
const ALLOWED = {
  admin: ['rungis_cmd_get', 'rungis_alert', ...BL_ACTIONS],
  rungis: ['rungis_cmd_get', 'rungis_alert', ...BL_ACTIONS],
  pdp: ['rungis_alert'],
};
const cut = (v, n) => String(v == null ? '' : v).slice(0, n);

exports.kbgRungisLogin = onCall({ region: REGION }, async (req) => {
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

exports.kbgRungis = onCall({ region: REGION, secrets: [KBG_FL_EXEC_URL, KBG_FL_SHARED_SECRET], timeoutSeconds: 120 }, async (req) => {
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
  if (BL_ACTIONS.includes(action)) {   // v1.3 — contrôle BL : champs bornés, le PDF n'est jamais stocké ici
    const pdf = String(d.pdf || '');
    if (action === 'rungis_bl_check' && (!pdf || pdf.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(pdf))) throw new HttpsError('invalid-argument', 'PDF invalide ou trop lourd (6 Mo max).');
    Object.assign(payload, {
      pdf: action === 'rungis_bl_check' ? pdf : undefined, name: cut(d.name, 120), subject: cut(d.subject, 200), source: 'appli Espace Rungis',
      blCode: cut(d.blCode, 10), blDes: cut(d.blDes, 120), codes: cut(d.codes, 80), key: cut(d.key, 40), n: Math.min(50, Number(d.n) || 20), force: d.force === true,
    });
  }
  let res;
  try {
    res = await fetch(KBG_FL_EXEC_URL.value(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
  } catch (e) { throw new HttpsError('unavailable', 'Apps Script injoignable.'); }
  const txt = await res.text();
  try { return JSON.parse(txt); } catch (e) { throw new HttpsError('unavailable', 'Réponse Apps Script invalide (déploiement ?) : ' + txt.slice(0, 120)); }
});
