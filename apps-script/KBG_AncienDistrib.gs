/**
 * KBG_AncienDistrib.gs — v1.3 (01/11/2026)
 * v1.3 : • Dernière minute NON prévue, arrivée après la clôture de la prépa et donnée au client (appli V10.81 :
 *          « ✅ C'est fait : donné au client » → day_<jour>_lmdone/lmadd|<client>) : sur l'ancien site le produit est
 *          dans « Supprimés » (manquant en prépa) → « Remettre » (orders/update-item, action « unremove », liste
 *          « removed »), AVANT les retraits / remises et la roue. Relance sans risque : plus dans Supprimés = déjà fait.
 * v1.2 (01/11/2026)
 * v1.2 : • « ❌ Pas arrivé » (dernière minute prévue 🟣 en prépa, comptée présente sur l'ancien site) → le produit est
 *          ENLEVÉ automatiquement de la commande du client sur l'ancien site (avant : « à retirer dans l'ancienne appli »
 *          à la main). Source : day_<jour>_prep, documents st|<lieu||client||produit> { v:'rupture', lmPasArrive:true }.
 *          Pivot = ID commande + ID produit (retrouvés dans day_<jour>_orders), jamais le nom seul. Pas de doublon avec
 *          un retrait déjà saisi en distrib sur le même produit.
 *        • Appels réseau via KBG_Reseau (kbFetch_ / kbFetchAll_ : relance sur coupure réseau Google).
 * v1.1 : • Ancien site : le passage (roue) est validé pour TOUS les clients du lieu (passés ou non), sinon la distrib
 *          ne peut pas être clôturée sur l'ancien site. Les remises / retraits restent ceux saisis dans l'appli.
 *        • 23h : un lieu qui a eu des commandes et n'est pas clôturé dans l'appli est CLÔTURÉ AUTOMATIQUEMENT
 *          (même écriture que le bouton : suivi des non-passés + day_<jour>_closure, marqué autoClosed), puis reporté.
 *          Faute enregistrée dans closure_faults/<jour>_<lieu> avec les personnes connectées sur le lieu ce jour-là
 *          (nom pris des actions faites avec leur code : passages, arrivées, remises) → popup dans l'appli.
 *        • 8h le lendemain : UN mail à rr@pribon.org + hg@pribon.org listant les lieux non clôturés et les personnes.
 *        • DOM (livraison à domicile) : jamais clôturé dans l'appli → ni clôture auto ni faute.
 * v1.0 (29/10/2026)
 * REPORT AUTOMATIQUE DE LA DISTRIBUTION SUR L'ANCIEN SITE (distributions.kelbongoo.com)
 * À ajouter dans le projet Apps Script « FL_Probon_Proxy » (même projet que KBG_Ancien.gs / KBG_Rungis.gs / KBG_BL.gs).
 * ---------------------------------------------------------------------------------------------------------
 * Même principe que KBG_Ancien (prépa) : plus de navigateur, plus de PC allumé.
 * L'ancien site de distribution n'est qu'une API (relevée le 29/10/2026 dans Chrome) :
 *   GET https://distributions-new.kelbongoo.com/<route>?params=<JSON>&options=<JSON>
 *   en-tête  Authorization: token <jeton Firebase>   (même projet Firebase que preparations.kelbongoo.com)
 *   • orders/fetch-detail                    → commande : globalorder_id, locale, status, items[], removed[], reduced[]
 *   • orders/update-item                     → bouton quantité : action « remove » (Enlever) ou « reduce » (Remise %, entier)
 *   • globalorderlocales/mark-order-arrived  → la roue à droite (client passé) — status 2 « compilée » → 6 « terminée »
 *
 * Source = l'appli Kelbongoo (Firestore distribkbg), lue DIRECTEMENT par ce script (aucune modif de l'appli) :
 *   day_<jour>_closure   → lieux clôturés (seuls ceux-là sont reportés)
 *   day_<jour>_orders    → commandes (orderId = _id de l'ancien site), site, email
 *   day_<jour>_statuses  → passed:true = client passé
 *   day_<jour>_refunds   → remises de la distrib : productId (= producerproduct_id), qty, pct (≥ 100 = retrait total)
 *   day_<jour>_prep      → (v1.2) dernière minute « pas arrivée » : retrait total
 * Règles :
 *   - Remises / retraits saisis dans l'appli → reportés (raison Autre), puis passage (roue) validé pour TOUS les clients
 *     du lieu (v1.1 : obligatoire pour clôturer l'ancien site).  Commande du nouveau site (PrestaShop) → rien.
 *   - Raison toujours « Autre » (3). Remise = pourcentage entier (arrondi). Remise sur une partie des articles = quantité.
 *   - Pivot = ID commande + ID produit, jamais le nom. Commande fusionnée (course + ajout) : le produit est cherché
 *     dans toutes les commandes du même client (même lieu + même e-mail).
 *   - Relance sans risque : on compare avec ce qui est déjà enlevé / remisé sur l'ancien site (déjà fait = rien à refaire).
 *
 * Déclencheur : toutes les heures (ancienDistribAuto) → entre 17h et minuit, reporte chaque lieu clôturé du jour pas encore fait.
 * Fin de chaque lieu → journal dans l'onglet « ANCIEN DISTRIB » du Sheet COMMANDE FL + mail récap à hg@probon.fr.
 *
 * RÉGLAGES (Fichier › Paramètres du projet › Propriétés du script) — à saisir par Henry, jamais dans le code :
 *   DIS_EMAIL / DIS_PASSWORD : compte de connexion de distributions.kelbongoo.com (compte anouar)
 *   DIS_LIVE = true          : autorise les écritures. Sinon : SIMULATION (calcule et rapporte, n'écrit rien).
 * MANIFESTE (appsscript.json) : si « oauthScopes » y est listé, ajouter
 *   "https://www.googleapis.com/auth/datastore"  (lecture Firestore distribkbg avec le compte hg@probon.fr).
 */

var DIS_API      = 'https://distributions-new.kelbongoo.com/';
var DIS_FB_KEY   = 'AIzaSyApzz9odc0DMgHTwcwLQ69lP58n1njIWKI';   // clé publique Firebase de l'ancien site (même que la prépa)
var DIS_FS       = 'https://firestore.googleapis.com/v1/projects/distribkbg/databases/(default)/documents/';
var DIS_TAB      = 'ANCIEN DISTRIB';
var DIS_MAIL_TO  = 'hg@probon.fr';
var DIS_REASON   = 3;          // « Autre »
var DIS_SLICE_MS = 270000;     // 4 min 30 de travail par passage
var DIS_LANES    = 10;         // commandes traitées en parallèle
var DIS_HOURS    = [17, 24];   // fenêtre du déclencheur horaire (heure de Paris)
var DIS_AUTOCLOSE_H = 23;      // clôture automatique des lieux oubliés
var DIS_FAULT_MAIL_H = 8;      // mail des oublis, le lendemain
var DIS_FAULT_TO = 'rr@pribon.org,hg@pribon.org';
var DIS_NO_CLOSE = { DOM: 1 }; // lieux jamais clôturés dans l'appli
var DIS_VERSION  = 'v1.3';

/* ═════════════════════════════ CONNEXION ANCIEN SITE ═════════════════════════════ */
function disProps_() { return PropertiesService.getScriptProperties(); }
function disLive_() { return String(disProps_().getProperty('DIS_LIVE') || '').toLowerCase() === 'true'; }
function disToken_() {
  var c = CacheService.getScriptCache(), t = c.get('DIS_TOKEN'); if (t) return t;
  var P = disProps_(), email = P.getProperty('DIS_EMAIL'), pass = P.getProperty('DIS_PASSWORD');
  if (!email || !pass) throw new Error('Compte distributions non configuré (propriétés DIS_EMAIL / DIS_PASSWORD)');
  var r = kbFetch_('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + DIS_FB_KEY, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ email: email, password: pass, returnSecureToken: true }) });
  var j = {}; try { j = JSON.parse(r.getContentText()); } catch (e) {}
  if (r.getResponseCode() !== 200 || !j.idToken) throw new Error('Connexion distributions refusée : ' + ((j.error && j.error.message) || r.getResponseCode()));
  c.put('DIS_TOKEN', j.idToken, 3000);
  return j.idToken;
}
function disReq_(route, params) {
  return { url: DIS_API + route + '?params=' + encodeURIComponent(JSON.stringify(params || {})) + '&options=' + encodeURIComponent('{}'),
    headers: { Authorization: 'token ' + disToken_() }, muteHttpExceptions: true };
}
function disParse_(r) {
  var code = r.getResponseCode(), txt = r.getContentText(), j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (code === 401 || code === 403) CacheService.getScriptCache().remove('DIS_TOKEN');
  if (code !== 200) throw new Error('HTTP ' + code + ' ' + String((j && (j.message || j.error)) || txt).slice(0, 160));
  return j;
}
function disAll_(reqs) {
  if (!reqs.length) return [];
  return kbFetchAll_(reqs).map(function (r) { try { return { ok: true, j: disParse_(r) }; } catch (e) { return { ok: false, err: String(e.message || e) }; } });
}
function disDetailReq_(oid) { return disReq_('orders/fetch-detail', { order_id: oid, getBoutiqueOrder: false, getComments: false, getOrderBacs: false, getPayments: false }); }

/* ═════════════════════════════ LECTURE FIRESTORE (appli) ═════════════════════════════ */
function fsVal_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsVal_);
  if ('mapValue' in v) return fsFields_(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}
function fsFields_(f) { var o = {}; Object.keys(f || {}).forEach(function (k) { o[k] = fsVal_(f[k]); }); return o; }
function fsGet_(url) {
  var r = kbFetch_(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  var code = r.getResponseCode();
  if (code === 404) return null;
  if (code !== 200) throw new Error('Firestore HTTP ' + code + ' ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText());
}
function fsDoc_(coll, id) { var d = fsGet_(DIS_FS + encodeURIComponent(coll) + '/' + encodeURIComponent(id)); return d ? fsFields_(d.fields) : null; }
function fsList_(coll) {
  var out = [], tok = '';
  for (var k = 0; k < 50; k++) {
    var d = fsGet_(DIS_FS + encodeURIComponent(coll) + '?pageSize=300' + (tok ? '&pageToken=' + encodeURIComponent(tok) : ''));
    if (!d) break;
    (d.documents || []).forEach(function (x) { var o = fsFields_(x.fields); o.id = decodeURIComponent(String(x.name).split('/').pop()); out.push(o); });
    tok = d.nextPageToken || ''; if (!tok) break;
  }
  return out;
}

/* ═════════════════════════════ ÉCRITURE FIRESTORE (clôture auto, v1.1) ═════════════════════════════ */
function fsEnc_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsEnc_) } };
  if (typeof v === 'object') { var f = {}; Object.keys(v).forEach(function (k) { f[k] = fsEnc_(v[k]); }); return { mapValue: { fields: f } }; }
  return { stringValue: String(v) };
}
/** Écrit les champs de obj dans le document (fusion : les autres champs du document sont gardés). */
function fsPatch_(coll, id, obj) {
  var keys = Object.keys(obj), fields = {};
  keys.forEach(function (k) { fields[k] = fsEnc_(obj[k]); });
  var url = DIS_FS + encodeURIComponent(coll) + '/' + encodeURIComponent(id) + '?' + keys.map(function (k) { return 'updateMask.fieldPaths=' + encodeURIComponent(k); }).join('&');
  var r = kbFetch_(url, { method: 'patch', contentType: 'application/json', payload: JSON.stringify({ fields: fields }),
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Firestore écriture ' + coll + '/' + id + ' : HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
}

/* ═════════════════════════════ PLAN (fonctions pures, testées hors Apps Script) ═════════════════════════════ */
var DIS_OLD_ID = /^[0-9a-f]{24}$/;
/** Tous les clients d'un lieu (commandes de l'ancien site), avec leurs remises. orders/statuses/refunds = données Firestore de l'appli.
 *  → [{ client, email, oids:[ids ancien site], passed:[ids passés dans l'appli], refunds:[{pp, produit, qty, pct, oid}] }]
 *  v1.1 : tous les clients (passés ou non) — la roue est validée pour tous sur l'ancien site. */
function disBuildClients_(site, orders, statuses, refunds, adds) {
  site = String(site).toUpperCase();
  var passed = {}; (statuses || []).forEach(function (s) { if (s && s.passed === true) passed[String(s.orderId || s.id)] = true; });
  var byKey = {}, keyOf = {};
  (orders || []).forEach(function (o) {
    var oid = String(o.orderId || ''); if (String(o.site || '').toUpperCase() !== site || !DIS_OLD_ID.test(oid)) return;
    var k = String(o.email || '').toLowerCase().trim() || ('#' + oid);
    var c = byKey[k] || (byKey[k] = { client: o.name || '', email: o.email || '', oids: [], passed: [], refunds: [], adds: [] });
    c.oids.push(oid); if (passed[oid]) c.passed.push(oid); keyOf[oid] = k;
  });
  (refunds || []).forEach(function (r) {
    var k = keyOf[String(r.orderId || '')]; if (!k) return;
    var pct = Number(r.pct) || 0, qty = Math.max(1, parseInt(r.qty, 10) || 1);
    if (pct <= 0) return;
    byKey[k].refunds.push({ pp: String(r.productId || ''), produit: r.produit || '', qty: qty, pct: pct >= 100 ? 100 : Math.max(1, Math.min(99, Math.round(pct))), oid: String(r.orderId) });
  });
  // v1.3 — dernière minute non prévue donnée au client → à remettre
  (adds || []).forEach(function (a) {
    var oid = null; (a.orderIds || []).some(function (x) { if (keyOf[String(x)]) { oid = String(x); return true; } return false; }); if (!oid) return;
    (a.items || []).forEach(function (it) { var q = Math.max(1, parseInt(it.qty, 10) || 1); byKey[keyOf[oid]].adds.push({ pp: String(it.productId || ''), produit: it.produit || '', qty: q, oid: oid }); });
  });
  return Object.keys(byKey).map(function (k) { return byKey[k]; });
}
/** v1.3 — documents « lmadd|… » de day_<jour>_lmdone (appli V10.81), cochés « donné au client ». Fonction pure. */
function disLmAdds_(lmdoneDocs) {
  return (lmdoneDocs || []).filter(function (d) { return d && d.done === true && String(d.id || '').indexOf('lmadd|') === 0 && (d.items || []).length; })
    .map(function (d) { return { orderIds: (d.orderIds || []).map(String), items: d.items || [] }; });
}
/** v1.2 — « ❌ Pas arrivé » (dernière minute) → retraits totaux, au même format que day_<jour>_refunds.
 *  prepDocs = documents de day_<jour>_prep ; id « st|<clé encodée> », clé = lieu||client||produit (client = o.name).
 *  Un retrait déjà saisi en distrib (même commande + même produit, pct ≥ 100) n'est pas doublé. Fonction pure. */
function disLmKo_(orders, prepDocs, refunds) {
  var dec = function (s) { s = String(s || ''); for (var i = 0; i < 2 && /%[0-9A-Fa-f]{2}/.test(s); i++) { try { s = decodeURIComponent(s); } catch (e) { break; } } return s; };
  var has = {}; (refunds || []).forEach(function (r) { if ((Number(r.pct) || 0) >= 100) has[String(r.orderId) + '|' + String(r.productId || '')] = 1; });
  var out = [];
  (prepDocs || []).forEach(function (d) {
    if (!d || d.v !== 'rupture' || d.lmPasArrive !== true) return;
    var id = String(d.id || ''), bar = id.indexOf('|'); if (bar < 0 || id.slice(0, bar) !== 'st') return;
    var p = dec(id.slice(bar + 1)).split('||'); if (p.length < 3) return;
    var site = p[0].toUpperCase(), client = p[1], produit = p.slice(2).join('||');
    (orders || []).forEach(function (o) {
      if (o._test || String(o.site || '').toUpperCase() !== site || String(o.name || '(client)') !== client) return;
      (o.items || []).forEach(function (it) {
        if (String(it.produit || '') !== produit || !it.id) return;
        var k = String(o.orderId) + '|' + String(it.id); if (has[k]) return; has[k] = 1;
        out.push({ orderId: String(o.orderId), productId: String(it.id), produit: produit, qty: Number(it.qty || it.quantity) || 1, pct: 100, site: site, lmKo: true });
      });
    });
  });
  return out;
}
/** Appels à faire pour UN client. det = { oid: order (réponse fetch-detail) }.
 *  → { calls:[{oid, route, params, label}], lines:[texte], warn:[texte] } */
function disPlanClient_(c, det) {
  var calls = [], lines = [], warn = [];
  var avail = {}, exRem = {}, exRed = {};
  c.oids.forEach(function (oid) {
    var o = det[oid]; if (!o) return;
    var a = avail[oid] = {}, er = exRem[oid] = {}, ed = exRed[oid] = {};
    (o.items || []).forEach(function (it) { a[it.producerproduct_id] = (a[it.producerproduct_id] || 0) + (Number(it.quantity) || 0); });
    (o.removed || []).forEach(function (it) { er[it.producerproduct_id] = (er[it.producerproduct_id] || 0) + (Number(it.quantity) || 0); });
    (o.reduced || []).forEach(function (it) { var m = ed[it.producerproduct_id] || (ed[it.producerproduct_id] = {}); m[it.percentage] = (m[it.percentage] || 0) + (Number(it.quantity) || 0); });
  });
  // v1.3 — « Remettre » les dernières minutes non prévues données au client (Supprimés → Remettre), en premier
  var addW = {};
  (c.adds || []).forEach(function (a) {
    if (!a.pp) { warn.push(a.produit + ' : dernière minute sans ID produit — à remettre à la main'); return; }
    var w = addW[a.pp] || (addW[a.pp] = { pp: a.pp, qty: 0, produit: a.produit, pref: a.oid }); w.qty += a.qty;
  });
  Object.keys(addW).forEach(function (pp) {
    var w = addW[pp], need = w.qty;
    var cands = [w.pref].concat(c.oids.filter(function (x) { return x !== w.pref; })).filter(function (oid) { return det[oid]; });
    var inRem = cands.reduce(function (s, oid) { return s + (exRem[oid][pp] || 0); }, 0);
    if (!inRem) { lines.push(w.produit + ' : dernière minute déjà remise (plus dans Supprimés)'); return; }
    cands.forEach(function (oid) {
      if (need <= 0) return;
      var q = Math.min(need, exRem[oid][pp] || 0); if (q <= 0) return;
      exRem[oid][pp] -= q; avail[oid][pp] = (avail[oid][pp] || 0) + q; need -= q;
      calls.push({ oid: oid, route: 'orders/update-item', params: { order_id: oid, params: { listName: 'removed', list: 'removed', producerproduct_id: pp, quantity: q, action: 'unremove', isConsumer: false } }, label: w.produit + ' : remis ×' + q + ' (dernière minute)', add: true });
    });
    if (need > 0) warn.push(w.produit + ' : ' + need + ' dernière(s) minute(s) de plus que les Supprimés de l\'ancien site — non remis');
  });
  // remises voulues regroupées par produit + % (retrait = 100)
  var want = {};
  c.refunds.forEach(function (r) {
    if (!r.pp) { warn.push(r.produit + ' : remise sans ID produit — à faire à la main'); return; }
    var k = r.pp + '|' + r.pct; var w = want[k] || (want[k] = { pp: r.pp, pct: r.pct, qty: 0, produit: r.produit, pref: r.oid }); w.qty += r.qty;
  });
  Object.keys(want).forEach(function (k) {
    var w = want[k];
    // commande de l'ancien site qui contient ce produit (celle de la remise d'abord, sinon une autre du même client)
    var cands = [w.pref].concat(c.oids.filter(function (x) { return x !== w.pref; })).filter(function (oid) { return det[oid] && (avail[oid][w.pp] || exRem[oid][w.pp] || exRed[oid][w.pp]); });
    if (!cands.length) { warn.push(w.produit + ' : produit absent de la commande sur l\'ancien site — non reporté'); return; }
    var done = 0; cands.forEach(function (oid) { done += w.pct === 100 ? (exRem[oid][w.pp] || 0) : ((exRed[oid][w.pp] || {})[w.pct] || 0); });
    var need = w.qty - done;
    if (need <= 0) { lines.push(w.produit + ' : ' + (w.pct === 100 ? 'enlevé' : '−' + w.pct + ' %') + ' ×' + w.qty + ' déjà fait'); return; }
    cands.forEach(function (oid) {
      if (need <= 0) return;
      var q = Math.min(need, avail[oid][w.pp] || 0); if (q <= 0) return;
      avail[oid][w.pp] -= q; need -= q;
      var p = { listName: 'items', producerproduct_id: w.pp, quantity: q, reason: DIS_REASON, action: w.pct === 100 ? 'remove' : 'reduce', list: 'items', isConsumer: false };
      if (w.pct < 100) p.percentage = w.pct;
      calls.push({ oid: oid, route: 'orders/update-item', params: { order_id: oid, params: p }, label: w.produit + ' : ' + (w.pct === 100 ? 'enlevé ×' + q : 'remise −' + w.pct + ' % ×' + q) });
    });
    if (need > 0) warn.push(w.produit + ' : ' + need + ' article(s) de plus que la commande de l\'ancien site — reste non reporté');
  });
  // passage (roue) après les ajustements, pour CHAQUE commande du client encore « compilée » (v1.1 : passés ou non)
  c.oids.forEach(function (oid) {
    var o = det[oid]; if (!o) { warn.push('commande ' + oid + ' introuvable sur l\'ancien site'); return; }
    if (Number(o.status) >= 6) { lines.push('passage déjà validé'); return; }
    calls.push({ oid: oid, route: 'globalorderlocales/mark-order-arrived', params: { globalorder_id: o.globalorder_id, locale: o.locale, order_id: oid }, label: c.passed.indexOf(oid) >= 0 ? 'passage validé' : 'passage validé (non passé dans l\'appli)', last: true });
  });
  return { calls: calls, lines: lines, warn: warn };
}

/* ═════════════════════════════ TRAVAIL ═════════════════════════════ */
function disParisNow_() { return Utilities.formatDate(new Date(), 'Europe/Paris', 'yyyy-MM-dd HH').split(' '); }
/** Déclencheur horaire. */
function ancienDistribAuto() {
  var now = disParisNow_(), h = Number(now[1]);
  if (h === DIS_FAULT_MAIL_H) { disFaultMail_(disAddDays_(now[0], -1)); return; }
  if (h < DIS_HOURS[0] || h >= DIS_HOURS[1]) return;
  if (h >= DIS_AUTOCLOSE_H) disAutoClose_(now[0]);
  ancienDistribJour(now[0]);
}
/* ── LANCEMENT MANUEL D'UN LIEU ── changer le jour / le lieu ici, puis exécuter ancienDistribManuel dans l'éditeur.
 *  DIS_LIVE absent = SIMULATION (mail « à faire », rien n'est écrit) ; DIS_LIVE = true = report réel. */
var DIS_MANUEL = { day: '2026-10-28', site: 'PDP' };
function ancienDistribManuel() {
  var cache = 'ancien_distrib_' + DIS_MANUEL.day + '_' + DIS_MANUEL.site + '.json'; disJobDel_(cache);
  ancienDistribJour(DIS_MANUEL.day, true, DIS_MANUEL.site);
  Logger.log('Lancé : ' + DIS_MANUEL.site + ' du ' + DIS_MANUEL.day + ' · ' + (disLive_() ? 'RÉEL' : 'SIMULATION') + ' → voir le mail et l\'onglet « ANCIEN DISTRIB »');
}
function disAddDays_(day, n) { var d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
/** Reprise d'un passage trop long. */
function ancienDistribContinue() {
  disTriggersDel_('ancienDistribContinue');
  var P = disProps_(), d = P.getProperty('DIS_CONT_DAY'), s = P.getProperty('DIS_CONT_SITE') || '';
  if (d) ancienDistribJour(d, !!s, s || undefined);
}
/** Lance le report d'un jour (YYYY-MM-DD, défaut aujourd'hui) : tous les lieux clôturés pas encore faits. force = refaire même si fait. */
function ancienDistribJour(day, force, onlySite) {
  day = day || disParisNow_()[0];
  var lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) return;
  try {
    // lancement manuel d'un lieu : on ne demande pas la clôture dans l'appli
    var closures = onlySite ? [{ site: String(onlySite).toUpperCase() }] : fsList_('day_' + day + '_closure').filter(function (c) { return c.closedAt; });
    if (!closures.length) return;
    var od = fsDoc_('day_' + day + '_orders', 'data'), orders = (od && od.orders) || [];
    var statuses = fsList_('day_' + day + '_statuses'), refunds = fsList_('day_' + day + '_refunds');
    // v1.2 — dernière minute « pas arrivée » : retrait total automatique
    var prepDocs = []; try { prepDocs = fsList_('day_' + day + '_prep'); } catch (e) {}
    refunds = refunds.concat(disLmKo_(orders, prepDocs, refunds));
    // v1.3 — dernières minutes non prévues données au client
    var lmAdds = []; try { lmAdds = disLmAdds_(fsList_('day_' + day + '_lmdone')); } catch (e) {}
    var t0 = Date.now(), P = disProps_();
    for (var i = 0; i < closures.length; i++) {
      var site = String(closures[i].site || closures[i].id).toUpperCase();
      var key = (disLive_() ? 'DIS_DONE_' : 'DIS_SIM_') + day + '_' + site;   // une simulation n'empêche pas le report réel
      if (!force && P.getProperty(key)) continue;
      var jobName = 'ancien_distrib_' + day + '_' + site + '.json';
      var st = disJobGet_(jobName) || { day: day, site: site, dry: !disLive_(), i: 0, startedAt: new Date().toISOString(), res: { clients: 0, passages: 0, enleves: 0, remises: 0, deja: 0, erreurs: [], warn: [], detail: [], appels: 0 } };
      var clients = disBuildClients_(site, orders, statuses, refunds, lmAdds);
      st.n = clients.length;
      while (st.i < clients.length && Date.now() - t0 < DIS_SLICE_MS) {
        disDoLane_(clients.slice(st.i, st.i + DIS_LANES), st);
        st.i = Math.min(clients.length, st.i + DIS_LANES);
        disJobPut_(jobName, disTrim_(st));
      }
      if (st.i < clients.length) {
        P.setProperty('DIS_CONT_DAY', day); P.setProperty('DIS_CONT_SITE', onlySite ? String(onlySite).toUpperCase() : '');
        disTriggersDel_('ancienDistribContinue');
        ScriptApp.newTrigger('ancienDistribContinue').timeBased().after(60000).create();
        return;
      }
      st.endedAt = new Date().toISOString();
      disLog_(st); disMail_(st);
      disJobDel_(jobName);
      if (st.dry || !st.res.erreurs.length) P.setProperty(key, st.endedAt);   // erreur en réel → retenté à l'heure suivante
    }
  } catch (e) {
    MailApp.sendEmail({ to: DIS_MAIL_TO, subject: '⚠️ Ancien site distrib ' + day + ' : arrêté', body: String(e && e.stack || e), name: 'Kelbongoo' });
  } finally { lock.releaseLock(); }
}
/* état d'un lieu en cours (fichier Drive, comme KBG_Ancien : trop gros pour une propriété) */
function disJobFile_(name) { var it = rgFolder_().getFilesByName(name); return it.hasNext() ? it.next() : null; }
function disJobGet_(name) { var f = disJobFile_(name); if (!f) return null; try { return JSON.parse(f.getBlob().getDataAsString()); } catch (e) { return null; } }
function disJobPut_(name, st) { var f = disJobFile_(name), s = JSON.stringify(st); if (f) f.setContent(s); else rgFolder_().createFile(name, s, 'application/json'); }
function disJobDel_(name) { var f = disJobFile_(name); if (f) f.setTrashed(true); }
function disTrim_(st) { if (st.res.detail.length > 600) st.res.detail = st.res.detail.slice(-600); return st; }
function disTriggersDel_(fn) { ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); }); }

function disDoLane_(clients, st) {
  var R = st.res, oids = [];
  clients.forEach(function (c) { c.oids.forEach(function (o) { oids.push(o); }); });
  var gets = disAll_(oids.map(disDetailReq_)), det = {};
  R.appels += gets.length;
  oids.forEach(function (oid, k) { if (gets[k].ok && gets[k].j && gets[k].j.order) det[oid] = gets[k].j.order; });
  var queues = clients.map(function (c) {
    var pl = disPlanClient_(c, det);
    R.clients++;
    pl.warn.forEach(function (w) { R.warn.push(c.client + ' — ' + w); });
    return { c: c, calls: pl.calls, done: [], lines: pl.lines, err: 0 };
  });
  if (!st.dry) {
    // une écriture par client et par tour (jamais 2 à la fois sur une même commande), clients en parallèle ; la roue en dernier
    for (var guard = 0; guard < 40; guard++) {
      var batch = [], who = [];
      queues.forEach(function (q) { if (q.calls.length && !q.err) { var x = q.calls.shift(); batch.push(disReq_(x.route, x.params)); who.push({ q: q, x: x }); } });
      if (!batch.length) break;
      var rs = disAll_(batch); R.appels += rs.length;
      rs.forEach(function (r, k) {
        var q = who[k].q, x = who[k].x;
        if (r.ok) { q.done.push(x.label); disCount_(R, x); }
        else { q.err++; R.erreurs.push(q.c.client + ' — ' + x.label + ' : ' + r.err); q.calls = []; }   // erreur → on n'enchaîne pas (pas de roue)
      });
    }
  } else queues.forEach(function (q) { q.calls.forEach(function (x) { q.done.push('à faire : ' + x.label); disCount_(R, x); }); });
  queues.forEach(function (q) {
    if (!q.done.length && !q.err) R.deja++;
    R.detail.push({ c: q.c.client, s: q.err ? 'err' : (q.done.length ? (st.dry ? 'afaire' : 'ok') : 'deja'), d: q.done.concat(q.lines).join(' · ') || 'rien à faire' });
  });
}
function disCount_(R, x) {
  if (x.route === 'globalorderlocales/mark-order-arrived') R.passages++;
  else if (x.params.params.action === 'unremove') R.remis = (R.remis || 0) + x.params.params.quantity;
  else if (x.params.params.action === 'remove') R.enleves += x.params.params.quantity;
  else R.remises += x.params.params.quantity;
}

/* ═════════════════════════════ JOURNAL / MAIL ═════════════════════════════ */
function disLog_(st) {
  var ss = blSs_(), sh = ss.getSheetByName(DIS_TAB), R = st.res;
  if (!sh) { sh = ss.insertSheet(DIS_TAB); sh.getRange(1, 1, 1, 7).setValues([['DISTRIBUTION', 'LIEU', 'LANCÉ', 'FINI', 'MODE', 'RÉSULTAT', 'DÉTAIL']]).setFontWeight('bold').setBackground('#1a4d2e').setFontColor('#fff'); sh.setFrozenRows(1); }
  sh.appendRow([st.day, st.site, st.startedAt, st.endedAt, st.dry ? 'SIMULATION' : 'RÉEL', R.erreurs.length ? '⚠️ ' + R.erreurs.length + ' ERREUR(S)' : '✅ OK',
    R.clients + ' client(s) · ' + R.passages + ' passage(s) · ' + R.enleves + ' enlevé(s) · ' + R.remises + ' remisé(s) · ' + R.deja + ' déjà à jour' + (R.warn.length ? ' · ' + R.warn.length + ' alerte(s)' : '')]);
}
function disMail_(st) {
  var R = st.res, ok = !R.erreurs.length;
  var li = function (t, a, c) { return a && a.length ? '<div style="margin-top:12px"><div style="font-size:15px;font-weight:800;color:' + c + '">' + t + ' (' + a.length + ')</div><ul style="margin:4px 0;padding-left:18px;font-size:13px">' + a.map(function (x) { return '<li>' + rgEsc_(x) + '</li>'; }).join('') + '</ul></div>' : ''; };
  var actifs = R.detail.filter(function (d) { return d.s !== 'deja'; }).map(function (d) { return d.c + ' : ' + d.d; });
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;color:#1b1b1b">'
    + '<div style="background:' + (ok ? '#2e7d32' : '#c62828') + ';color:#fff;border-radius:14px;padding:16px 20px"><div style="font-size:23px;font-weight:900">' + (ok ? '✅' : '⚠️') + ' Ancien site — distrib ' + rgEsc_(st.site) + ' du ' + rgEsc_(rgLong_(st.day)) + (st.dry ? ' (SIMULATION)' : '') + '</div>'
    + '<div style="font-size:16px;margin-top:4px">' + R.clients + ' client(s) · ' + R.deja + ' déjà à jour</div></div>'
    + '<p style="font-size:15px;margin:12px 2px"><b>' + R.passages + '</b> passage(s) validé(s) · <b>' + R.enleves + '</b> article(s) enlevé(s) · <b>' + R.remises + '</b> article(s) remisé(s)' + (R.remis ? ' · <b>' + R.remis + '</b> dernière(s) minute(s) remise(s)' : '') + (st.dry ? ' — <b>à faire</b> (rien n\'a été écrit)' : '') + '</p>'
    + li('⚠️ Erreurs', R.erreurs, '#c62828') + li('ℹ️ Alertes (à vérifier à la main)', R.warn, '#b45309') + li('🧾 Détail', actifs, '#1a4d2e')
    + '<p style="color:#999;font-size:12px;margin-top:16px">Report automatique KBG_AncienDistrib ' + DIS_VERSION + ' · ' + (st.dry ? 'simulation (DIS_LIVE ≠ true)' : 'réel') + ' · ' + R.appels + ' appel(s)</p></div>';
  MailApp.sendEmail({ to: DIS_MAIL_TO, subject: (ok ? '✅' : '⚠️') + ' Ancien site distrib ' + st.site + ' ' + rgFr_(st.day) + (st.dry ? ' (simulation)' : '') + ' : ' + R.passages + ' passage(s), ' + R.enleves + ' enlevé(s), ' + R.remises + ' remisé(s)', htmlBody: html, name: 'Kelbongoo' });
}

/* ═════════════════════════════ CLÔTURE AUTO 23H + FAUTES (v1.1) ═════════════════════════════ */
/** Personnes connectées sur le lieu ce jour-là (actions faites avec leur code), la plus active d'abord. Fonction pure. */
function disResponsables_(site, statuses, refunds) {
  var n = {}, add = function (x) { x = String(x || '').trim(); if (x && x !== '—') n[x] = (n[x] || 0) + 1; };
  (statuses || []).forEach(function (s) { if (String(s.site || '').toUpperCase() !== site) return; add(s.updatedBy); add(s.arrivedBy); });
  (refunds || []).forEach(function (r) { if (String(r.site || '').toUpperCase() === site) add(r.createdBy); });
  return Object.keys(n).sort(function (a, b) { return n[b] - n[a] || a.localeCompare(b); }).map(function (k) { return { nom: k, actions: n[k] }; });
}
/** Lieux à clôturer d'office : commandes du jour, pas de clôture, pas DOM. Fonction pure. */
function disOublis_(orders, closures) {
  var closed = {}, sites = {};
  (closures || []).forEach(function (c) { if (c.closedAt) closed[String(c.site || c.id).toUpperCase()] = 1; });
  (orders || []).forEach(function (o) { var s = String(o.site || '').toUpperCase(); if (s && !o._test && !DIS_NO_CLOSE[s] && !closed[s]) sites[s] = 1; });
  return Object.keys(sites).sort();
}
function disAutoClose_(day) {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) return;
  try {
    var od = fsDoc_('day_' + day + '_orders', 'data'), orders = (od && od.orders) || [];
    var oublis = disOublis_(orders, fsList_('day_' + day + '_closure'));
    if (!oublis.length) return;
    var statuses = fsList_('day_' + day + '_statuses'), refunds = fsList_('day_' + day + '_refunds');
    var passed = {}; statuses.forEach(function (s) { if (s.passed === true) passed[String(s.orderId || s.id)] = 1; });
    var at = new Date().toISOString(), by = 'Clôture automatique 23h (oubli)';
    oublis.forEach(function (site) {
      var vis = orders.filter(function (o) { return String(o.site || '').toUpperCase() === site && !o._test; });
      var notP = vis.filter(function (o) { return !passed[o.orderId]; }), resp = disResponsables_(site, statuses, refunds);
      // même suivi que le bouton « Clôturer » de l'appli : un suivi par client non passé
      notP.forEach(function (o) {
        fsPatch_('followups', String(o.orderId), { orderId: String(o.orderId), site: site, consumer_name: o.name || '', clientName: o.name || '', email: o.email || '',
          phone: o.tel || '', hasPhone: !!o.tel, day: day, distribDate: day, items: o.items || [],
          casiers: (o.casiersFrais || []).concat(o.casiersSec || []).map(String).filter(function (x, i, a) { return a.indexOf(x) === i; }),
          status: 'pending', createdBy: by, createdAt: at });
      });
      var ps = vis.filter(function (o) { return !DIS_OLD_ID.test(String(o.orderId)); }).length;
      fsPatch_('day_' + day + '_closure', site, { site: site, closedBy: by, closedAt: at, notPassedCount: notP.length, passedCount: vis.length - notP.length,
        autoClosed: true, responsables: resp.map(function (r) { return r.nom; }), factuWebPending: ps > 0 });
      fsPatch_('closure_faults', day + '_' + site, { day: day, site: site, responsables: resp, autoClosedAt: at, clients: vis.length, nonPasses: notP.length,
        commandesNouveauSite: ps, mailed: false, acks: [] });
    });
  } catch (e) {
    MailApp.sendEmail({ to: DIS_MAIL_TO, subject: '⚠️ Clôture automatique 23h ' + day + ' : erreur', body: String(e && e.stack || e), name: 'Kelbongoo' });
  } finally { lock.releaseLock(); }
}
/** 8h : UN mail avec tous les lieux non clôturés la veille. */
function disFaultMail_(day) {
  var P = disProps_(), key = 'DIS_FAULTMAIL_' + day; if (P.getProperty(key)) return;
  var F = fsList_('closure_faults').filter(function (f) { return f.day === day && !f.mailed; }).sort(function (a, b) { return String(a.site).localeCompare(String(b.site)); });
  P.setProperty(key, new Date().toISOString());
  if (!F.length) return;
  var who = function (f) { var r = f.responsables || []; return r.length ? r.map(function (x) { return x.nom + ' (' + x.actions + ' action' + (x.actions > 1 ? 's' : '') + ')'; }).join(', ') : 'personne — distrib jamais ouverte dans l\'appli'; };
  var rows = F.map(function (f) { return '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:800">' + rgEsc_(f.site) + '</td><td style="padding:6px 10px;border-bottom:1px solid #eee">' + rgEsc_(who(f)) + '</td><td style="padding:6px 10px;border-bottom:1px solid #eee">' + (f.clients || 0) + ' client(s) · ' + (f.nonPasses || 0) + ' non passé(s)' + (f.commandesNouveauSite ? '<br><b style="color:#c62828">' + f.commandesNouveauSite + ' commande(s) nouveau site à facturer : Master › Facturation web</b>' : '') + '</td></tr>'; }).join('');
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:700px;color:#1b1b1b">'
    + '<div style="background:#c62828;color:#fff;border-radius:14px;padding:16px 20px"><div style="font-size:22px;font-weight:900">⚠️ Distribution non clôturée — ' + rgEsc_(rgLong_(day)) + '</div>'
    + '<div style="font-size:15px;margin-top:4px">' + F.length + ' lieu(x) clôturé(s) automatiquement à 23h</div></div>'
    + '<table style="border-collapse:collapse;width:100%;margin-top:12px;font-size:14px"><tr style="background:#f5f5f5"><th align="left" style="padding:6px 10px">Lieu</th><th align="left" style="padding:6px 10px">Personne(s) sur le lieu</th><th align="left" style="padding:6px 10px">Distribution</th></tr>' + rows + '</table>'
    + '<p style="font-size:14px;margin-top:12px">Ne pas clôturer la distribution est une faute : le report sur l\'ancien site, le suivi des clients non passés et la facturation des clients (paiements) en dépendent. Une alerte s\'affiche dans l\'appli sur chaque lieu concerné.</p>'
    + '<p style="color:#999;font-size:12px">KBG_AncienDistrib ' + DIS_VERSION + ' · personnes = actions faites avec leur code dans l\'appli ce jour-là (passages, arrivées, remises)</p></div>';
  MailApp.sendEmail({ to: DIS_FAULT_TO, subject: '⚠️ Distribution non clôturée le ' + rgFr_(day) + ' : ' + F.map(function (f) { return f.site; }).join(', '), htmlBody: html, name: 'Kelbongoo' });
  F.forEach(function (f) { try { fsPatch_('closure_faults', f.id, { mailed: true, mailedAt: new Date().toISOString() }); } catch (e) {} });
}

/* ═════════════════════════════ MISE EN SERVICE / ESSAIS ÉDITEUR ═════════════════════════════ */
/** À lancer une fois : crée le déclencheur horaire. */
function ancienDistribInstaller() {
  disTriggersDel_('ancienDistribAuto');
  ScriptApp.newTrigger('ancienDistribAuto').timeBased().everyHours(1).create();
  Logger.log('Déclencheur horaire créé · écriture ' + (disLive_() ? 'ACTIVÉE' : 'désactivée (simulation)'));
}
/** Lecture seule : connexion ancien site + lecture Firestore du jour. */
function ancienDistribTest() {
  var day = disParisNow_()[0];
  disToken_();
  var clo = fsList_('day_' + day + '_closure'), od = fsDoc_('day_' + day + '_orders', 'data');
  Logger.log('Connexion distributions OK · ' + day + ' : ' + ((od && od.orders) || []).length + ' commandes dans l\'appli · lieux clôturés : ' + (clo.map(function (c) { return c.site || c.id; }).join(', ') || 'aucun') + ' · écriture ' + (disLive_() ? 'ACTIVÉE' : 'désactivée (simulation)'));
}
/** Lecture seule : quels lieux seraient clôturés d'office maintenant, et avec quels noms. */
function ancienDistribTestOublis() {
  var day = disParisNow_()[0], od = fsDoc_('day_' + day + '_orders', 'data'), orders = (od && od.orders) || [];
  var st = fsList_('day_' + day + '_statuses'), rf = fsList_('day_' + day + '_refunds');
  var o = disOublis_(orders, fsList_('day_' + day + '_closure'));
  Logger.log(day + ' · non clôturés : ' + (o.map(function (s) { return s + ' [' + disResponsables_(s, st, rf).map(function (r) { return r.nom; }).join(', ') + ']'; }).join(' · ') || 'aucun'));
}
/** v1.2 — Lecture seule : retraits « pas arrivé » (dernière minute) qui seront reportés pour un jour. */
function ancienDistribTestLmKo(day) {
  day = day || disParisNow_()[0];
  var od = fsDoc_('day_' + day + '_orders', 'data'), orders = (od && od.orders) || [];
  var ko = disLmKo_(orders, fsList_('day_' + day + '_prep'), fsList_('day_' + day + '_refunds'));
  Logger.log(day + ' · ' + ko.length + ' retrait(s) « pas arrivé » : ' + ko.map(function (r) { return r.site + ' ' + r.produit + ' ×' + r.qty + ' (' + r.orderId + ')'; }).join(' · '));
}
/** Refaire un jour à la main (ex. ancienDistribRefaire('2026-10-28')). */
function ancienDistribRefaire(day) { ancienDistribJour(day || disParisNow_()[0], true); }
