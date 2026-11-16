/**
 * pribon — Cloud Functions « connexion unique » Centrale PDP · Console · Réception magasins
 * v1.0 (16/11/2026) — projet Firebase distribkbg, région europe-west1, base de code séparée « pribon ».
 * ---------------------------------------------------------------------------------------------
 * Fichier AUTONOME : ne modifie aucune fonction existante (kbgLogin, kbgClaimAdmin, kbgProxy, rungis…).
 *
 *  pribonLogin (HTTPS POST, JSON) : vérifie l'identité puis délivre un JETON Firebase par base autorisée.
 *    { mode:"code",   action:"verify-code"|"verify-login", code, storeCode, … }  → opérateur Centrale / vendeur magasin
 *    { mode:"google", action:"verify-responsable"|"magasin-login", idToken }      → responsable / bureau magasin
 *    Réponse : la réponse du registre (valid / allowed / …) + tokens:{ prep?, rob?, bic? } + role.
 *
 *  Qui vérifie quoi : le registre des codes et la liste des responsables restent dans l'Apps Script
 *  « PRIBON RECEPTION » (source unique). Cette fonction l'interroge côté serveur, puis signe les jetons avec
 *  la clé de service de chaque projet (Secret Manager — jamais dans un fichier, jamais dans GitHub).
 *
 *  Rôles posés dans le jeton (lus par les règles Firebase) :
 *    role: "operateur" | "vendeur" | "magasin" | "responsable"   ·   store: code magasin (vendeur / magasin)
 *
 * Installation : Cloud Shell (compte propriétaire), une seule ligne :
 *   bash <(curl -sL https://raw.githubusercontent.com/gvs93/kelbongoo/main/server/install_pribon.sh)
 */
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

const REGION = 'europe-west1';
const SA_PREP = defineSecret('PRIBON_SA_PREP');           // clé de service kelbongoo-prep (JSON)
const SA_ROB = defineSecret('PRIBON_SA_ROB');             // clé de service robespierre-65cdf (JSON)
const SA_BIC = defineSecret('PRIBON_SA_BIC');             // clé de service bichat-80d62 (JSON)
const REGISTRE_URL = defineSecret('PRIBON_REGISTRE_URL'); // URL /exec de l'Apps Script PRIBON RECEPTION
const UID_PEPPER = defineSecret('PRIBON_UID_PEPPER');     // sel : l'identifiant du jeton ne révèle jamais le code

// Pages autorisées à appeler la fonction depuis un navigateur.
const ORIGINS = ['https://pribon.github.io', 'https://gvs93.github.io'];
// Base Firebase de chaque magasin (code du registre → clé de jeton).
const STORE_DB = { ROBESPIERRE: 'rob', ROB: 'rob', BICHAT: 'bic', BIC: 'bic' };

const cut = (v, n) => String(v == null ? '' : v).slice(0, n);
const apps = {};
function appFor(key, json) {
  if (!apps[key]) apps[key] = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(json)) }, 'pribon-' + key);
  return apps[key];
}
async function mint(keys, uid, claims) {
  const src = { prep: SA_PREP, rob: SA_ROB, bic: SA_BIC }, out = {};
  for (const k of keys) out[k] = await appFor(k, src[k].value()).auth().createCustomToken(uid, claims);
  return out;
}
async function registre(payload) {
  const r = await fetch(REGISTRE_URL.value(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (e) { throw new Error('registre : réponse illisible (' + r.status + ')'); }
}

// Frein par adresse IP (par instance) : 12 demandes / minute. Le frein global « mauvais codes » est dans le registre.
const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter((t) => now - t < 60000);
  a.push(now); hits.set(ip, a);
  if (hits.size > 5000) hits.clear();
  return a.length > 12;
}

exports.pribonLogin = onRequest({ region: REGION, secrets: [SA_PREP, SA_ROB, SA_BIC, REGISTRE_URL, UID_PEPPER], cors: ORIGINS, timeoutSeconds: 60, maxInstances: 10 }, async (req, res) => {
  const fail = (code, msg) => res.status(code).json({ ok: false, error: msg });
  if (req.method !== 'POST') return fail(405, 'POST uniquement');
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  if (tooMany(ip)) return fail(429, 'Trop de demandes. Réessaie dans une minute.');
  let d = req.body;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
  if (!d || typeof d !== 'object') return fail(400, 'requête invalide');
  const mode = String(d.mode || ''), action = String(d.action || '');
  try {
    if (mode === 'code') {
      if (action !== 'verify-code' && action !== 'verify-login') return fail(400, 'action inconnue');
      const code = cut(d.code, 12).trim();
      if (!/^\d{3,8}$/.test(code)) return res.json({ ok: true, valid: false, reason: 'format' });
      const storeCode = cut(d.storeCode, 60);
      const j = await registre({ action, code, storeCode, storeSessionCode: cut(d.storeSessionCode, 20), scope: cut(d.scope, 20), moduleColumn: cut(d.moduleColumn, 60), module: cut(d.module, 20) });
      if (!j || j.valid !== true) return res.json({ ok: true, valid: false, reason: cut(j && j.reason, 200) });
      const uid = 'c_' + crypto.createHmac('sha256', UID_PEPPER.value()).update(code).digest('hex').slice(0, 24);
      let keys, claims;
      if (action === 'verify-code') { keys = ['prep']; claims = { role: 'operateur', module: cut(d.module, 20) }; }
      else { const k = STORE_DB[storeCode.toUpperCase()]; keys = k ? [k, 'prep'] : ['prep']; claims = { role: 'vendeur', store: storeCode.toUpperCase() }; }
      return res.json({ ...j, ok: true, valid: true, role: claims.role, tokens: await mint(keys, uid, claims) });
    }
    if (mode === 'google') {
      const idToken = cut(d.idToken, 4000);
      if (!idToken) return fail(400, 'jeton Google manquant');
      if (action === 'verify-responsable') {
        const j = await registre({ action, idToken });
        if (!j || j.ok === false) return fail(401, cut(j && j.error, 200) || 'jeton refusé');
        if (j.allowed !== true) return res.json({ ok: true, allowed: false });
        const uid = 'g_' + crypto.createHash('sha256').update(String(j.email)).digest('hex').slice(0, 24);
        return res.json({ ok: true, allowed: true, email: j.email, role: 'responsable', tokens: await mint(['prep', 'rob', 'bic'], uid, { role: 'responsable', email: cut(j.email, 120) }) });
      }
      if (action === 'magasin-login') {
        const j = await registre({ action, idToken });
        if (!j || j.allowed !== true) return res.json({ ...(j || {}), ok: true, allowed: false });
        const k = STORE_DB[String(j.storeCode || '').toUpperCase()];
        const uid = 'm_' + crypto.createHash('sha256').update(String(j.email)).digest('hex').slice(0, 24);
        return res.json({ ...j, ok: true, role: 'magasin', tokens: await mint(k ? [k, 'prep'] : ['prep'], uid, { role: 'magasin', store: String(j.storeCode || '').toUpperCase() }) });
      }
      return fail(400, 'action inconnue');
    }
    return fail(400, 'mode inconnu');
  } catch (e) {
    console.error('pribonLogin', e);
    return fail(502, 'Serveur de connexion indisponible.');
  }
});