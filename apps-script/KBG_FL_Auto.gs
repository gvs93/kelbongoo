/**
 * KBG_FL_Auto.gs — v1.3 (19/10/2026) — à AJOUTER au projet Apps Script FL_Probon_Proxy (ne rien remplacer).
 *
 * Deux automatismes sur le Sheet « COMMANDE FL KBG x PROBON » (onglet COMMANDE FL) :
 *
 *  1) VENTES 5H (remplace la saisie de Rungis à 5h)
 *     Chaque matin vers 4h30 (Paris), le script lit sur admin.kelbongoo.com les ventes de la distribution
 *     du LENDEMAIN (Globales › date › Produits › dernière colonne « vendus », ex. Champignon de Paris 22 | 273 → 22)
 *     et écrit ce nombre dans la colonne « COMMANDE A 5H » (D) de chaque produit ACTIF (par ID SITE KBG, sinon par nom).
 *     ESTIMATION MU (= D × 1,15) se recalcule seule. Si plusieurs ventes globales ont la même date, elles s'additionnent.
 *
 *  2) CONTRÔLE AUTOMATIQUE (autonome) — producerproducts (admin) + PVTTC Rungis
 *     - Fiche produit du site (admin) → DESIGNATION, PRODUCTEUR, UNITE DE VENTE (« sachet (450g-550g) »),
 *       TYPE (sachet/barquette/paquet → SACHET, pièce → PIECE, botte → BOTTE), MU EN KILO (poids unitaire ;
 *       si Rungis achète à la PIÈCE : nombre de pièces, 1 par défaut, 3 pour « x3 »).
 *     - Feuille PVTTC Rungis (onglet de la semaine) → CODE PROBON (si correspondance sûre), COL, PRIX ACHAT HT, PRIX VENTE TTC.
 *     - ID SITE KBG réparé si vide ou pointant vers un produit inactif alors qu'un produit actif du même nom est en vente.
 *     - Tout ce qui ne peut pas être décidé seul est listé dans l'onglet FL_AUTO_RAPPORT (lu par l'appli Master › F&L) :
 *       concordances à faire ensemble, produits rouges chez Rungis (→ passer inactif ?), incohérence unité d'achat
 *       (UA PCE chez Rungis mais vendu en sachet), écart prix d'achat / prix producteur, écart PVTTC / prix consommateur
 *       (tolérance ±0,10 € : arrondi décimale sup. ou inf. = OK), produits de COMMANDE FL absents de PVTTC,
 *       produits en vente sur le site absents de COMMANDE FL.
 *     - Chaque cellule modifiée est tracée dans l'onglet FL_AUTO_LOG (avant → après).
 *
 * INSTALLATION (une fois) :
 *  1. Projet FL_Probon_Proxy → + Fichier → Script → « KBG_FL_Auto » → coller ce code.
 *  2. Paramètres du projet (roue dentée) → Propriétés du script → ajouter :
 *        KBG_ADMIN_EMAIL = e-mail d'un compte admin.kelbongoo.com (idéalement un compte dédié « robot »)
 *        KBG_ADMIN_PASS  = son mot de passe
 *     (ces valeurs restent sur le serveur Google, jamais dans l'appli)
 *  3. Dans doPost (Code.gs), juste APRÈS la ligne du secret et AVANT « switch (p.action) { » :
 *        if (p.secret !== SHARED_SECRET) throw new Error('secret invalide');
 *        if (String(p.action || '').indexOf('fl_auto_') === 0) return kbFlAutoRoute_(p);   // ← ligne à ajouter
 *        switch (p.action) {
 *  4. Exécuter UNE fois la fonction flAutoTest (menu Exécuter) → autoriser → le journal doit afficher
 *     « connexion admin OK » et les ventes de la prochaine distribution.
 *  5. Exécuter UNE fois flAutoInstall → crée les déclencheurs (4h30 ventes + contrôle, 14h contrôle).
 *  6. Gérer les déploiements → crayon → Nouvelle version → Déployer (NE PAS créer un nouveau déploiement).
 *     Le contrôle remet aux normes TOUTES les lignes (actives et non actives) ; les décisions ne portent que sur les actives.
 *  7. (une fois) Exécuter flMiseEnForme → sauvegarde du fichier puis mise en forme lisible de COMMANDE FL
 *     (couleurs par rôle de colonne, notes d'explication, actifs en haut, onglet « MODE D'EMPLOI »).
 *     Aucune colonne n'est déplacée, renommée ni supprimée : l'appli et les scripts lisent par nom d'en-tête.
 *
 * v1.1 : alertes à hg@probon.fr + rr@pribon.org + gestion@probon.fr ; nouvelles lignes insérées sous le dernier
 *        produit actif ; flMiseEnForme().
 */

var KBA = {
  FL_SS_ID: '1PXQU4QP_bh_sRCEHonrMM7FkWmJWtNPyxDBPPRBlNVQ',     // COMMANDE FL KBG x PROBON
  FL_TAB: 'COMMANDE FL',
  PV_SS_ID: '1kos7dUgxUwqWY-7l8KIHMiE4GwVXE3Uy9wrRHBesPBo',     // PVTTC RUNGIS/PDP (1 onglet par semaine)
  REPORT_TAB: 'FL_AUTO_RAPPORT',
  LOG_TAB: 'FL_AUTO_LOG',
  ADMIN: 'https://admin.kelbongoo.com',
  TZ: 'Europe/Paris',
  FL_CAT_NAME: 'fruits legumes',                                  // « Fruits, Légumes » normalisé
  FL_CAT_ID: '57e9295c08c44eb29e0f69b3',
  TOL: 0.10,                                                      // tolérance prix (€)
  ALERT_TO: 'hg@probon.fr,rr@pribon.org,gestion@probon.fr',  // alertes (ventes 5h non écrites…)
  HEAD: { prod: ['PRODUCTEUR'], des: ['DESIGNATION'], code: ['CODE PROBON'], cmd5: ['COMMANDE A 5H'], col: ['COL', 'COLISAGE'],
          uv: ['UNITE DE VENTE'], type: ['TYPE'], mu: ['MU EN KILO'], pa: ['PRIX ACHAT HT'], pv: ['PRIX VENTE TTC'],
          actif: ['ACTIF ?', 'ACTIF'], id: ['ID SITE KBG'] }
};

/* ============================ ROUTAGE (doPost) ============================ */
function kbFlAutoRoute_(data) {
  var out;
  try {
    switch (String(data.action)) {
      case 'fl_auto_report':  out = flAutoReport_(); break;
      case 'fl_auto_run':     out = flAutoSchedule_(data.what || 'tout'); break;
      case 'fl_auto_concord': out = flAutoConcord_(data); break;
      case 'fl_auto_actif':   out = flAutoSetActif_(data); break;
      case 'fl_auto_ignore':  out = flAutoIgnore_(data); break;
      case 'fl_auto_add':     out = flAutoAdd_(data); break;
      case 'fl_auto_setid':   out = flAutoSetId_(data); break;
      default: out = { ok: false, error: 'action inconnue : ' + data.action };
    }
  } catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================ DÉCLENCHEURS ============================ */
function flAutoInstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'flAuto5h' || f === 'flAutoControle' || f === 'flAutoOnce' || f === 'flAutoVeille') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('flAutoVeille').timeBased().everyHours(1).create();        // v1.3 : veille « vendu mais absent » (7h→22h)
  ScriptApp.newTrigger('flAuto5h').timeBased().atHour(4).nearMinute(30).everyDays(1).inTimezone(KBA.TZ).create();
  ScriptApp.newTrigger('flAutoControle').timeBased().atHour(14).nearMinute(0).everyDays(1).inTimezone(KBA.TZ).create();
  Logger.log('Déclencheurs créés : flAuto5h (≈4h30) + flAutoControle (≈14h) + flAutoVeille (toutes les heures, 7h→22h), fuseau Europe/Paris.');
}

/** ≈4h30 : contrôle complet (répare les ID site), puis ventes du lendemain → colonne D. */
function flAuto5h() {
  var ventes = null;
  try { flAutoControle(); }
  catch (e2) { flAutoMeta_({ controleErr: String(e2 && e2.message || e2), controleErrAt: new Date().toISOString() }); }
  try { ventes = flAutoVentes(); }
  catch (e) { flAutoMeta_({ ventesErr: String(e && e.message || e), ventesErrAt: new Date().toISOString() }); flAutoAlert_('Ventes 5h NON écrites', String(e && e.message || e)); }
  return ventes;
}

/** Lancé par un déclencheur unique programmé depuis l'appli (évite les délais du proxy). */
function flAutoOnce() {
  var props = PropertiesService.getScriptProperties();
  var what = props.getProperty('FL_AUTO_ONCE') || 'tout';
  props.deleteProperty('FL_AUTO_ONCE');
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'flAutoOnce') ScriptApp.deleteTrigger(t); });
  if (what === 'ventes' || what === 'tout') { try { flAutoVentes(); } catch (e) { flAutoMeta_({ ventesErr: String(e.message || e), ventesErrAt: new Date().toISOString() }); } }
  if (what === 'controle' || what === 'tout') { try { flAutoControle(); } catch (e2) { flAutoMeta_({ controleErr: String(e2.message || e2), controleErrAt: new Date().toISOString() }); } }
}

function flAutoSchedule_(what) {
  what = ['ventes', 'controle', 'tout'].indexOf(what) >= 0 ? what : 'tout';
  var props = PropertiesService.getScriptProperties();
  var prev = props.getProperty('FL_AUTO_ONCE');
  props.setProperty('FL_AUTO_ONCE', prev && prev !== what ? 'tout' : what);
  var already = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'flAutoOnce'; });
  if (!already) ScriptApp.newTrigger('flAutoOnce').timeBased().after(1000).create();
  flAutoMeta_({ runningSince: new Date().toISOString(), runningWhat: what });
  return { ok: true, scheduled: true, what: what };
}

/** Test manuel (journal) : connexion + ventes de la prochaine distribution, sans rien écrire. */
function flAutoTest() {
  var ddp = new KbDdp_();
  ddp.connect(); ddp.login();
  Logger.log('connexion admin OK');
  var gos = flAutoGlobalOrders_(ddp);
  gos.slice(0, 4).forEach(function (g) { Logger.log(g.title + ' · ' + g._id + ' · ' + g.day + ' · statut ' + g.status); });
  var tomorrow = flAutoDay_(1);
  var tg = gos.filter(function (g) { return g.day === tomorrow; });
  if (!tg.length) { Logger.log('Pas de vente pour demain (' + tomorrow + ')'); return; }
  var q = ddp.call('globalorders.getGoppsQuantities', [{ globalorder_id: tg[0]._id, getComments: false, getQuantitySold: true }]);
  var n = 0; for (var k in q.sold) if (q.sold[k] > 0) n++;
  Logger.log('Vente du ' + tomorrow + ' : ' + n + ' produits avec ventes. Ex. champignon de Paris (67fca549…) = ' + (q.sold['67fca549eb9482001276155d'] || 0));
}

/* ============================ 1) VENTES 5H ============================ */
/** dry=true (veille horaire) : ne touche PAS au Sheet, met seulement à jour meta.veille (produits vendus absents du Sheet). */
function flAutoVentes(targetDay, dry) {
  var lock = LockService.getScriptLock(); lock.waitLock(60000);
  try {
    var day = targetDay || flAutoDay_(1);
    var ddp = new KbDdp_(); ddp.connect(); ddp.login();
    var gos = flAutoGlobalOrders_(ddp).filter(function (g) { return g.day === day; });
    if (!gos.length) {
      var r0 = { at: new Date().toISOString(), day: day, none: true };
      flAutoMeta_(dry ? { veille: r0 } : { ventes: r0 }); return r0;
    }
    var sold = {}, flProd = {};
    gos.forEach(function (g) {
      var q = ddp.call('globalorders.getGoppsQuantities', [{ globalorder_id: g._id, getComments: false, getQuantitySold: true }]);
      var init = ddp.call('globalorders.getGoppsInit', [{ globalorder_id: g._id, includeBackgroundGopps: true }]);
      var cat = flAutoFlCatId_(init.categories);
      for (var id in (q.sold || {})) sold[id] = (sold[id] || 0) + (Number(q.sold[id]) || 0);
      (init.products || []).forEach(function (p) { if (p.category_id === cat) flProd[p.producerproduct_id] = p; });
    });

    var sh = SpreadsheetApp.openById(KBA.FL_SS_ID).getSheetByName(KBA.FL_TAB);
    var T = flAutoReadTable_(sh);
    var C = T.cols; if (C.cmd5 < 0) throw new Error('colonne « COMMANDE A 5H » introuvable');
    var colVals = sh.getRange(2, C.cmd5 + 1, Math.max(1, T.rows.length), 1).getValues();
    var used = {}, written = 0, zeros = 0, untouched = [];
    T.rows.forEach(function (r, i) {
      if (!r.des || !r.actifOk) return;
      // ID du Sheet s'il est dans la vente ; sinon même nom dans la vente (ID vide ou périmé) ; sinon 0 si ID connu.
      var id = (r.id && (flProd[r.id] || sold[r.id] != null)) ? r.id : (flAutoFindSale_(r.des, flProd, used, r.row) || '');
      var v;
      if (id) { v = Number(sold[id] || 0); used[id] = r.row; }
      else if (r.id) { v = 0; }                         // ID connu mais pas dans la vente de demain → 0
      else { untouched.push({ row: r.row, des: r.des }); return; }
      colVals[i][0] = v; written++; if (!v) zeros++;
    });
    var titles = gos.map(function (g) { return g.title; }).join(' + ');
    if (!dry) sh.getRange(2, C.cmd5 + 1, colVals.length, 1).setValues(colVals);
    if (!dry) sh.getRange(1, C.cmd5 + 1).setNote('Rempli automatiquement le ' + Utilities.formatDate(new Date(), KBA.TZ, 'dd/MM HH:mm') + ' — ventes du ' + titles + ' (admin.kelbongoo.com)');
    var soldMissing = [];
    var PVc = null, pvLazy = function () { if (!PVc) { try { PVc = flAutoReadPvttc_(); } catch (e) { PVc = { byCode: {}, list: [] }; } } return PVc; };
    for (var sid in flProd) if (!used[sid] && (sold[sid] || 0) > 0 && !/panier solidaire/i.test(flProd[sid].product_name))
      soldMissing.push(flAutoMissingInfo_(T, sid, flProd[sid], Number(sold[sid]), pvLazy));
    var res = { at: new Date().toISOString(), day: day, titles: titles, written: dry ? 0 : written, zeros: zeros, untouched: untouched, soldMissing: soldMissing };
    flAutoMeta_(dry ? { veille: res } : { ventes: res, ventesErr: '' });
    return res;
  } finally { lock.releaseLock(); }
}

/** v1.3 — produit VENDU mais sans ligne active dans COMMANDE FL : on calcule quand même de quoi le commander à Rungis.
 *  1) ligne « Non actif » du Sheet (même ID ou même nom) → code, colisage, MU, prix ;  2) sinon PVTTC (désignation sûre).
 *  colis = arrondi 0,1 de (ventes × 1,15 arrondi) × MU ÷ colisage (même règle que les colonnes du Sheet, sans stock). */
function flAutoMissingInfo_(T, sid, fp, n, pvLazy) {
  var C = T.cols, num = function (v) { var x = Number(String(v == null ? '' : v).replace(/[^\d,.\-]/g, '').replace(',', '.')); return isFinite(x) ? x : 0; };
  var o = { id: sid, des: fp.product_name, prod: fp.producer_name || '', n: n, estim: Math.round(n * 1.15), code: '', col: 0, mu: 0, pa: 0, colis: null, row: null, why: 'absent' };
  var r = T.rows.filter(function (x) { return x.des && !x.actifOk && (x.id === sid || kbaSame_(x.des, fp.product_name)); })[0];
  if (r) {
    o.row = r.row; o.why = 'inactif';
    o.code = C.code >= 0 ? String(r.raw[C.code] || '') : ''; o.col = C.col >= 0 ? num(r.raw[C.col]) : 0;
    o.mu = C.mu >= 0 ? num(r.raw[C.mu]) : 0; o.pa = C.pa >= 0 ? num(r.raw[C.pa]) : 0;
    if (!o.prod && C.prod >= 0) o.prod = String(r.raw[C.prod] || '');
  }
  if (!o.code || !o.col) {
    var PV = pvLazy(), b = flAutoBestRungis_(fp.product_name, PV, {});
    var g = o.code ? PV.byCode[o.code] : (b && b.sure) || null;
    if (g) { o.code = o.code || String(g.code); o.col = o.col || Number(g.col) || 0; o.pa = o.pa || Number(g.pa) || 0; o.ua = String(g.ua || '').toUpperCase(); }
  }
  if (!o.mu) o.mu = o.ua === 'PCE' ? flAutoPieces_(fp.product_name) : (Number(fp.unit_weight) || flAutoWeightOf_(fp.product_name) || 0);
  if (o.mu > 0 && o.col > 0) o.colis = Math.max(0.1, Math.round(o.estim * o.mu / o.col * 10) / 10);
  return o;
}
/** « Pomme Akane 750g Bio » → 0.75 (kg) ; « Carotte 1KG » → 1 ; sinon 0. */
function flAutoWeightOf_(name) {
  var m = String(name || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
  if (!m) return 0;
  var v = Number(m[1].replace(',', '.'));
  return /kg/i.test(m[2]) ? v : v / 1000;
}

/** v1.3 — VEILLE HORAIRE (7h→22h) : relit les ventes de la distribution de la PROCHAINE commande 5h
 *  (avant 5h : demain ; après 5h : après-demain) et liste les produits vendus sans ligne active dans COMMANDE FL.
 *  Lecture seule : la colonne COMMANDE A 5H n'est pas touchée (elle reste écrite à 4h30). Résultat : meta.veille (appli). */
function flAutoVeille() {
  var h = Number(Utilities.formatDate(new Date(), KBA.TZ, 'H'));
  if (h < 7 || h > 22) return null;
  try { var v = flAutoVentes(flAutoDay_(h < 5 ? 1 : 2), true); flAutoMeta_({ veilleErr: '' }); return v; }
  catch (e) { flAutoMeta_({ veilleErr: String(e && e.message || e), veilleErrAt: new Date().toISOString() }); return null; }
}

/* ============================ 2) CONTRÔLE ============================ */
function flAutoControle() {
  var lock = LockService.getScriptLock(); lock.waitLock(60000);
  try {
    var ss = SpreadsheetApp.openById(KBA.FL_SS_ID);
    var sh = ss.getSheetByName(KBA.FL_TAB);
    var T = flAutoReadTable_(sh), C = T.cols;
    ['des', 'code', 'col', 'uv', 'type', 'mu', 'pa', 'pv', 'actif', 'id', 'prod'].forEach(function (k) { if (C[k] < 0) throw new Error('colonne introuvable : ' + KBA.HEAD[k][0]); });
    var PV = flAutoReadPvttc_();
    var ignore = flAutoIgnoreList_();

    // ---- fiches produits (admin) : IDs du Sheet + produits F&L des ventes à venir ----
    var ddp = new KbDdp_(); ddp.connect(); ddp.login();
    var today = flAutoDay_(0);
    var upcoming = flAutoGlobalOrders_(ddp).filter(function (g) { return g.day >= today; });
    var saleFl = {};
    upcoming.forEach(function (g) {
      var init = ddp.call('globalorders.getGoppsInit', [{ globalorder_id: g._id, includeBackgroundGopps: true }]);
      var cat = flAutoFlCatId_(init.categories);
      (init.products || []).forEach(function (p) { if (p.category_id === cat) saleFl[p.producerproduct_id] = p; });
    });
    var ids = {}; T.rows.forEach(function (r) { if (r.id) ids[r.id] = 1; }); for (var s in saleFl) ids[s] = 1;
    var fetchErr = {};
    var PP = flAutoFetchDetails_(ddp, Object.keys(ids), fetchErr);
    // v1.2 : produit EN VENTE mais fiche illisible → on garde ce que la vente donne (nom, producteur, unité…) plutôt que « introuvable »
    for (var fs in saleFl) if (!PP[fs]) { var fp = {}; for (var fk in saleFl[fs]) fp[fk] = saleFl[fs][fk]; fp.active = true; fp._fromSale = true; PP[fs] = fp; }

    var issues = [], changes = [];
    var nowTxt0 = Utilities.formatDate(new Date(), KBA.TZ, 'dd/MM/yyyy HH:mm');
    // ---- produits en vente sur le site absents de COMMANDE FL : ajout auto si le code Rungis est sûr ----
    var codeAll = {}; T.rows.forEach(function (r) { if (r.code) codeAll[r.code] = r.row; });
    var added = 0;
    for (var aid in saleFl) {
      var ap = saleFl[aid];
      if (/panier solidaire/i.test(ap.product_name)) continue;
      if (T.rows.some(function (r) { return r.id === aid || (r.des && kbaSame_(r.des, ap.product_name)); })) continue;
      var ab = flAutoBestRungis_(ap.product_name, PV, codeAll);
      if (!ab.sure) continue;
      var nr = flAutoAddRow_(sh, T, PP[aid] || ap, ab.sure.code);
      codeAll[ab.sure.code] = nr.row; added++;
      changes.push([nowTxt0, nr.row, ap.product_name, '(nouvelle ligne)', '', 'Actif · code ' + ab.sure.code + ' ' + ab.sure.des, 'en vente sur le site, code Rungis identique']);
    }
    var activeRows = T.rows.filter(function (r) { return r.des && r.actifOk; });
    var idUsed = {}; activeRows.forEach(function (r) { if (r.id) idUsed[r.id] = r.row; });
    var codeUsed = {}; activeRows.forEach(function (r) { if (r.code) codeUsed[r.code] = r.row; });
    var nowTxt = Utilities.formatDate(new Date(), KBA.TZ, 'dd/MM/yyyy HH:mm');
    var set = function (r, key, val, src) {
      var c = C[key]; if (c < 0) return;
      var cur = r.raw[c];
      var same = (typeof val === 'number') ? (cur !== '' && cur !== null && Math.abs(Number(String(cur).replace(',', '.')) - val) < 1e-9)
                                           : (String(cur == null ? '' : cur).trim() === String(val).trim());
      if (same) return;
      sh.getRange(r.row, c + 1).setValue(val);
      changes.push([nowTxt, r.row, r.des, KBA.HEAD[key][0], cur === '' || cur == null ? '' : String(cur), String(val), src]);
      r.raw[c] = val;
      if (key === 'des') r.des = String(val);
    };
    var issueAct = function (type, r, detail, data) {
      var kt = (type === 'pa' || type === 'pv') && data && data.rungis != null ? type + ':' + data.rungis : type;
      var key = kt + '|' + (r ? kbaNorm_(r.des) : kbaNorm_((data && data.des) || ''));
      if (ignore[key]) return;
      issues.push([type, r ? r.row : '', r ? r.des : (data && data.des) || '', r ? String(r.raw[C.prod] || '') : (data && data.prod) || '', detail, JSON.stringify(data || {}), nowTxt]);
    };

    // Toutes les lignes (actives ET non actives) sont remises aux normes ; les décisions ne concernent que les actives.
    var allRows = T.rows.filter(function (r) { return r.des; });
    allRows.forEach(function (r) {
      var act = r.actifOk;
      var issue = act ? issueAct : function () {};
      // ---- ID SITE KBG : réparation si vide / inactif / introuvable (actifs seulement) ----
      var p = r.id ? PP[r.id] : null;
      if (act && (!p || !p.active)) {
        var cand = flAutoFindSale_(r.des, saleFl, idUsed, r.row);
        if (cand) { set(r, 'id', cand, 'ID site réparé (produit actif en vente du même nom)'); idUsed[cand] = r.row; r.id = cand; p = PP[cand] || null; }
      }
      if (!p) {
        var sug = flAutoSuggestSale_(r.des, saleFl, idUsed);
        var notRead = r.id && fetchErr[r.id];
        issue('noPP', r, !r.id ? 'pas d\'ID SITE KBG et aucun produit en vente du même nom'
                               : notRead ? 'fiche du site ' + r.id + ' non lue (admin : ' + fetchErr[r.id] + ') — relue au prochain contrôle'
                                         : 'ID SITE KBG ' + r.id + ' introuvable sur le site', { suggestions: sug });
      }

      // ---- correspondance Rungis (CODE PROBON) ----
      var g = r.code ? PV.byCode[r.code] : null;
      if (!r.code && act) {
        var best = flAutoBestRungis_(r.des, PV, codeUsed);
        if (best.sure) { set(r, 'code', best.sure.code, 'code Rungis (désignation identique) : ' + best.sure.des); r.code = best.sure.code; codeUsed[r.code] = r.row; g = best.sure; }
        else issue('concord', r, 'quel produit Rungis ?', { suggestions: best.top });
      } else if (r.code && !g) {
        issue('absentRungis', r, 'code ' + r.code + ' absent de PVTTC (' + PV.tab + ')', { code: r.code });
      }
      var ua = g ? String(g.ua || '').toUpperCase() : '';

      // ---- infos du site → Sheet ----
      if (p) {
        set(r, 'des', p.product_name, 'site');
        set(r, 'prod', p.producer_name, 'site');
        if (p.unit_display) set(r, 'uv', p.unit_display, 'site');
        var tag = kbaNorm_(p.unit_tag || (String(p.unit_display || '').split('(')[0]));
        var typ = flAutoTypeOf_(tag, ua);
        if (typ === 'INCOH') {
          issue('incoh', r, 'Rungis achète à la PIÈCE (' + g.des + ') mais le site vend en ' + (p.unit_tag || 'sachet') + ' → TYPE laissé à « ' + (r.raw[C.type] || '—') + ' »', { code: r.code, ua: ua, tag: p.unit_tag });
        } else if (typ) set(r, 'type', typ, 'site (type d\'unité « ' + (p.unit_tag || '') + ' »' + (ua ? ', UA ' + ua : '') + ')');
        var n = flAutoPieces_(p.product_name);
        var mu = ua === 'PCE' ? n : (ua === 'KG' || typ === 'SACHET' ? Number(p.unit_weight) : null);
        if (mu && mu > 0) set(r, 'mu', Math.round(mu * 1000) / 1000, ua === 'PCE' ? 'pièces par unité (Rungis à la pièce)' : 'poids unitaire du site');
      }

      // ---- Rungis → Sheet ----
      if (g) {
        if (Number(g.col) > 0) set(r, 'col', Number(g.col), 'PVTTC ' + PV.tab);
        if (Number(g.pa) > 0) set(r, 'pa', Number(g.pa), 'PVTTC ' + PV.tab);
        if (Number(g.pv) > 0) set(r, 'pv', Number(g.pv), 'PVTTC ' + PV.tab);
        if (g.red) issue('red', r, 'surligné ROUGE chez Rungis' + (g.com ? ' — ' + g.com : '') + ' → passer « Non actif » ?', { code: r.code, des: g.des });
        // ---- prix (unité de vente) ----
        if (p) {
          var f = ua === 'PCE' ? flAutoPieces_(p.product_name) : Number(p.unit_weight) || 0;
          if (f > 0) {
            var unit = ua === 'PCE' ? (f > 1 ? f + ' pièces' : 'la pièce') : (Math.round(f * 1000) + ' g');
            var epa = g.pa * f, epv = g.pv * f, ppa = (Number(p.producer_price) || 0) / 100, ppv = (Number(p.consumer_price) || 0) / 100;
            if (g.pa > 0 && ppa > 0 && Math.abs(epa - ppa) > KBA.TOL)
              issue('pa', r, 'prix producteur site ' + kbaEur_(ppa) + ' ≠ Rungis ' + kbaEur_(g.pa) + '/' + (ua === 'PCE' ? 'pce' : 'kg') + ' × ' + unit + ' = ' + kbaEur_(epa), { site: ppa, rungis: Math.round(epa * 100) / 100 });
            if (g.pv > 0 && ppv > 0 && Math.abs(epv - ppv) > KBA.TOL)
              issue('pv', r, 'prix consommateur site ' + kbaEur_(ppv) + ' ≠ PVTTC ' + kbaEur_(g.pv) + '/' + (ua === 'PCE' ? 'pce' : 'kg') + ' × ' + unit + ' = ' + kbaEur_(epv), { site: ppv, rungis: Math.round(epv * 100) / 100 });
          }
        }
      }
    });

    // ---- en vente sur le site mais « Non actif » dans COMMANDE FL / doublons d'ID ----
    var inactive = T.rows.filter(function (r) { return r.des && !r.actifOk; });
    for (var vid in saleFl) {
      var vp = saleFl[vid];
      if (/panier solidaire/i.test(vp.product_name)) continue;
      var match = function (r) { return r.id === vid || kbaSame_(r.des, vp.product_name); };
      if (activeRows.some(match)) continue;
      var ina = inactive.filter(match)[0];
      if (ina) issueAct('saleInactif', ina, 'en vente sur le site (« ' + vp.product_name + ' ») mais « Non actif » ici → Rungis ne le commande pas. Passer Actif ?', { id: vid });
    }
    activeRows.forEach(function (r) {
      if (!r.id) return;
      var twin = inactive.filter(function (x) { return x.id === r.id; })[0];
      if (twin) issueAct('dup', r, 'même ID site que la ligne ' + twin.row + ' (« ' + twin.des + ' », non actif) → supprimer la ligne ' + twin.row + ' ?', { twin: twin.row });
    });
    // ---- en vente sur le site mais absents de COMMANDE FL ----
    var sheetIds = {}; T.rows.forEach(function (r) { if (r.id) sheetIds[r.id] = 1; });
    for (var sid in saleFl) {
      var sp = saleFl[sid];
      if (sheetIds[sid] || T.rows.some(function (r) { return r.des && kbaSame_(r.des, sp.product_name); })) continue;
      if (/panier solidaire/i.test(sp.product_name)) continue;
      var b = flAutoBestRungis_(sp.product_name, PV, codeUsed);
      issueAct('newSale', null, 'en vente sur le site, pas dans COMMANDE FL' + (b.sure ? ' — Rungis : ' + b.sure.code + ' ' + b.sure.des : ''), { des: sp.product_name, prod: sp.producer_name, id: sid, suggestions: b.top });
    }
    // ---- chez Rungis mais pas dans COMMANDE FL (info) ----
    var allCodes = {}; T.rows.forEach(function (r) { if (r.code) allCodes[r.code] = 1; });
    var rungisOnly = PV.list.filter(function (x) { return !allCodes[x.code]; }).map(function (x) { return { code: x.code, des: x.des, red: x.red }; });

    // ---- écriture rapport + journal ----
    var rep = ss.getSheetByName(KBA.REPORT_TAB) || ss.insertSheet(KBA.REPORT_TAB);
    rep.clearContents();
    var head = [['TYPE', 'LIGNE', 'DESIGNATION', 'PRODUCTEUR', 'DETAIL', 'DATA', 'MAJ']];
    rep.getRange(1, 1, 1, 7).setValues(head).setFontWeight('bold');
    if (issues.length) rep.getRange(2, 1, issues.length, 7).setValues(issues);
    if (changes.length) {
      var lg = ss.getSheetByName(KBA.LOG_TAB) || ss.insertSheet(KBA.LOG_TAB);
      if (lg.getLastRow() === 0) lg.getRange(1, 1, 1, 7).setValues([['DATE', 'LIGNE', 'DESIGNATION', 'COLONNE', 'AVANT', 'APRES', 'SOURCE']]).setFontWeight('bold');
      lg.getRange(lg.getLastRow() + 1, 1, changes.length, 7).setValues(changes);
      if (lg.getLastRow() > 3000) lg.deleteRows(2, lg.getLastRow() - 3000);
    }
    var counts = {}; issues.forEach(function (x) { counts[x[0]] = (counts[x[0]] || 0) + 1; });
    var fe = Object.keys(fetchErr);
    var meta = { controle: { at: new Date().toISOString(), pvTab: PV.tab, rows: activeRows.length, changes: changes.length, added: added, counts: counts, rungisOnly: rungisOnly,
                             fichesNonLues: fe.length, fichesNonLuesEx: fe.slice(0, 5).map(function (id) { return id + ' : ' + fetchErr[id]; }) },
                 controleErr: '', runningSince: '', runningWhat: '' };
    flAutoMeta_(meta);
    return meta.controle;
  } finally { lock.releaseLock(); }
}

/* ============================ ACTIONS APPLI ============================ */
function flAutoReport_() {
  var ss = SpreadsheetApp.openById(KBA.FL_SS_ID);
  var rep = ss.getSheetByName(KBA.REPORT_TAB);
  var issues = [];
  if (rep && rep.getLastRow() > 1) {
    rep.getRange(2, 1, rep.getLastRow() - 1, 7).getValues().forEach(function (v) {
      var d = {}; try { d = JSON.parse(v[5] || '{}'); } catch (e) {}
      issues.push({ type: v[0], row: v[1], des: v[2], prod: v[3], detail: v[4], data: d, at: v[6] });
    });
  }
  var changes = [];
  var lg = ss.getSheetByName(KBA.LOG_TAB);
  if (lg && lg.getLastRow() > 1) {
    var n = Math.min(150, lg.getLastRow() - 1);
    lg.getRange(lg.getLastRow() - n + 1, 1, n, 7).getValues().reverse().forEach(function (v) {
      changes.push({ at: v[0] instanceof Date ? Utilities.formatDate(v[0], KBA.TZ, 'dd/MM/yyyy HH:mm') : String(v[0]), row: v[1], des: v[2], col: v[3], before: v[4], after: v[5], src: v[6] });
    });
  }
  return { ok: true, meta: flAutoMeta_(), issues: issues, changes: changes };
}

function flAutoConcord_(data) {
  var code = parseInt(data.code, 10);
  if (!(code > 0)) return { ok: false, error: 'code Rungis invalide' };
  var r = flAutoGuardRow_(data);
  var sh = r.sh, C = r.cols;
  sh.getRange(r.row, C.code + 1).setValue(code);
  flAutoLogOne_(r.row, r.des, 'CODE PROBON', r.cur[C.code], code, 'concordance validée' + (data.by ? ' par ' + data.by : ''));
  flAutoDropIssue_('concord', r.row);
  flAutoSchedule_('controle');
  return { ok: true, row: r.row, code: code };
}

function flAutoSetActif_(data) {
  var r = flAutoGuardRow_(data);
  var v = data.actif ? 'Actif' : 'Non actif';
  r.sh.getRange(r.row, r.cols.actif + 1).setValue(v);
  flAutoLogOne_(r.row, r.des, 'ACTIF ?', r.cur[r.cols.actif], v, 'validé' + (data.by ? ' par ' + data.by : '') + (data.why ? ' (' + data.why + ')' : ''));
  flAutoDropIssue_(null, r.row);
  return { ok: true, row: r.row, actif: v };
}

function flAutoSetId_(data) {
  var id = String(data.id || '').trim();
  if (!/^[0-9a-f]{24}$/i.test(id)) return { ok: false, error: 'ID site invalide' };
  var r = flAutoGuardRow_(data);
  r.sh.getRange(r.row, r.cols.id + 1).setValue(id);
  flAutoLogOne_(r.row, r.des, 'ID SITE KBG', r.cur[r.cols.id], id, 'produit du site choisi' + (data.by ? ' par ' + data.by : ''));
  flAutoDropIssue_('noPP', r.row);
  flAutoSchedule_('controle');
  return { ok: true, row: r.row, id: id };
}

function flAutoIgnore_(data) {
  var key = String(data.kind || '') + '|' + kbaNorm_(data.des || '');
  var props = PropertiesService.getScriptProperties();
  var L = {}; try { L = JSON.parse(props.getProperty('FL_AUTO_IGNORE') || '{}'); } catch (e) {}
  if (data.undo) delete L[key]; else L[key] = { at: new Date().toISOString(), by: data.by || '' };
  props.setProperty('FL_AUTO_IGNORE', JSON.stringify(L));
  flAutoDropIssue_(data.kind, data.row || null, data.des);
  return { ok: true, key: key };
}

/* ============================ OUTILS SHEET ============================ */
function flAutoReadTable_(sh) {
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var all = sh.getRange(1, 1, Math.max(2, lastRow), lastCol).getValues();
  var head = all[0].map(kbaNorm_);
  var cols = {};
  Object.keys(KBA.HEAD).forEach(function (k) {
    cols[k] = -1;
    KBA.HEAD[k].some(function (h) { var i = head.indexOf(kbaNorm_(h)); if (i >= 0) { cols[k] = i; return true; } return false; });
  });
  var rows = [];
  for (var i = 1; i < all.length; i++) {
    var v = all[i];
    var des = cols.des >= 0 ? String(v[cols.des] || '').trim() : '';
    var act = cols.actif >= 0 ? String(v[cols.actif] || '').trim() : '';
    var code = cols.code >= 0 ? parseInt(v[cols.code], 10) : NaN;
    rows.push({ row: i + 1, raw: v, des: des, actifOk: /^actif/i.test(act),
                id: cols.id >= 0 ? String(v[cols.id] || '').trim() : '', code: code > 0 ? code : null });
  }
  return { cols: cols, rows: rows };
}

/** Ajoute une ligne en fin de tableau (formules recopiées de la dernière ligne) ; le contrôle complète le reste. */
function flAutoAddRow_(sh, T, p, code) {
  var C = T.cols, lastCol = sh.getLastColumn();
  var last = 1, lastAct = 1;
  T.rows.forEach(function (r) { if (r.des) { last = Math.max(last, r.row); if (r.actifOk) lastAct = Math.max(lastAct, r.row); } });
  var base = lastAct >= 2 ? lastAct : last;                       // sous le dernier produit ACTIF (actifs groupés en haut)
  sh.insertRowAfter(base);
  var at = base + 1;
  T.rows.forEach(function (r) { if (r.row >= at) r.row++; });      // les lignes du dessous descendent d'un cran
  if (base >= 2) sh.getRange(base, 1, 1, lastCol).copyTo(sh.getRange(at, 1, 1, lastCol));   // formules, formats, listes
  var raw = sh.getRange(at, 1, 1, lastCol).getValues()[0];
  var formulas = sh.getRange(at, 1, 1, lastCol).getFormulas()[0];
  for (var j = 0; j < lastCol; j++) if (!formulas[j]) raw[j] = '';
  var put = function (k, v) { if (C[k] >= 0) raw[C[k]] = v; };
  put('prod', p.producer_name || ''); put('des', p.product_name || ''); put('code', code || '');
  put('cmd5', 0); put('actif', 'Actif'); put('id', p.producerproduct_id || p._id || '');
  var hs = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(kbaNorm_);
  ['stock mu', 'stock cagette'].forEach(function (h) { var i = hs.indexOf(h); if (i >= 0 && !formulas[i]) raw[i] = 0; });
  for (var k = 0; k < lastCol; k++) if (!formulas[k]) sh.getRange(at, k + 1).setValue(raw[k]);
  var row = { row: at, raw: raw, des: String(p.product_name || ''), actifOk: true, id: String(p.producerproduct_id || p._id || ''), code: code ? Number(code) : null };
  T.rows.push(row);
  return row;
}

function flAutoAdd_(data) {
  if (!data.id) return { ok: false, error: 'produit du site manquant' };
  var sh = SpreadsheetApp.openById(KBA.FL_SS_ID).getSheetByName(KBA.FL_TAB);
  var T = flAutoReadTable_(sh);
  if (T.rows.some(function (r) { return r.id === String(data.id); })) return { ok: false, error: 'déjà dans COMMANDE FL' };
  var code = parseInt(data.code, 10) > 0 ? parseInt(data.code, 10) : '';
  var r = flAutoAddRow_(sh, T, { _id: String(data.id), product_name: data.des || '', producer_name: data.prod || '' }, code);
  flAutoLogOne_(r.row, r.des, '(nouvelle ligne)', '', 'Actif' + (code ? ' · code ' + code : ''), 'ajout validé' + (data.by ? ' par ' + data.by : ''));
  flAutoDropIssue_('newSale', null, data.des);
  flAutoSchedule_('controle');
  return { ok: true, row: r.row };
}

function flAutoGuardRow_(data) {
  var row = parseInt(data.row, 10);
  if (!(row >= 2)) throw new Error('ligne invalide');
  var sh = SpreadsheetApp.openById(KBA.FL_SS_ID).getSheetByName(KBA.FL_TAB);
  var T = flAutoReadTable_(sh);
  var r = T.rows.filter(function (x) { return x.row === row; })[0];
  if (!r) throw new Error('ligne ' + row + ' hors du tableau');
  if (data.des && kbaNorm_(r.des) !== kbaNorm_(data.des)) throw new Error('la ligne ' + row + ' est « ' + r.des + ' » (le Sheet a bougé) — relance le contrôle');
  return { sh: sh, cols: T.cols, row: row, des: r.des, cur: r.raw };
}

function flAutoLogOne_(row, des, col, before, after, src) {
  var ss = SpreadsheetApp.openById(KBA.FL_SS_ID);
  var lg = ss.getSheetByName(KBA.LOG_TAB) || ss.insertSheet(KBA.LOG_TAB);
  if (lg.getLastRow() === 0) lg.getRange(1, 1, 1, 7).setValues([['DATE', 'LIGNE', 'DESIGNATION', 'COLONNE', 'AVANT', 'APRES', 'SOURCE']]).setFontWeight('bold');
  lg.appendRow([Utilities.formatDate(new Date(), KBA.TZ, 'dd/MM/yyyy HH:mm'), row, des, col, before == null ? '' : String(before), String(after), src]);
}

function flAutoDropIssue_(type, row, des) {
  var rep = SpreadsheetApp.openById(KBA.FL_SS_ID).getSheetByName(KBA.REPORT_TAB);
  if (!rep || rep.getLastRow() < 2) return;
  var vals = rep.getRange(2, 1, rep.getLastRow() - 1, 7).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    var v = vals[i];
    var hit = (!type || v[0] === type) && ((row && Number(v[1]) === Number(row)) || (des && kbaNorm_(v[2]) === kbaNorm_(des)));
    if (hit && (type || row)) rep.deleteRow(i + 2);
  }
}

function flAutoIgnoreList_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('FL_AUTO_IGNORE') || '{}'); } catch (e) { return {}; }
}

function flAutoMeta_(patch) {
  var props = PropertiesService.getScriptProperties();
  var m = {}; try { m = JSON.parse(props.getProperty('FL_AUTO_META') || '{}'); } catch (e) {}
  if (patch) {
    for (var k in patch) m[k] = patch[k];
    var s = JSON.stringify(m);
    if (s.length > 8500 && m.controle && m.controle.rungisOnly) { m.controle.rungisOnly = m.controle.rungisOnly.slice(0, 40); s = JSON.stringify(m); }
    if (s.length > 8500 && m.veille) { m.veille.untouched = []; m.veille.soldMissing = (m.veille.soldMissing || []).slice(0, 15); s = JSON.stringify(m); }
    if (s.length > 8500 && m.ventes) { m.ventes.untouched = (m.ventes.untouched || []).slice(0, 20); m.ventes.soldMissing = (m.ventes.soldMissing || []).slice(0, 20); s = JSON.stringify(m); }
    props.setProperty('FL_AUTO_META', s);
  }
  return m;
}

function flAutoAlert_(subject, body) {
  try {
    flAutoMeta_({ lastAlert: { at: new Date().toISOString(), subject: subject, body: body } });
    MailApp.sendEmail({ to: KBA.ALERT_TO, subject: '⚠️ KBG F&L auto — ' + subject,
      htmlBody: '<div style="font-family:Arial;font-size:16px"><h2 style="color:#c62828">⚠️ ' + subject + '</h2><p>' + String(body).replace(/</g, '&lt;') +
        '</p><p style="font-size:14px;color:#555">Rungis doit remplir la colonne D à la main ce matin si les ventes n\'ont pas été écrites.<br>Appli : Master › Fruits &amp; légumes › 🤖 Contrôle auto.</p></div>' });
  } catch (e) {}
}

/* ============================ PVTTC RUNGIS ============================ */
function flAutoReadPvttc_() {
  var ss = SpreadsheetApp.openById(KBA.PV_SS_ID);
  var sheets = ss.getSheets();
  var wk = Number(Utilities.formatDate(new Date(), KBA.TZ, 'w'));
  var best = null, bestN = -1;
  sheets.forEach(function (s) {
    var m = s.getName().match(/S\s*(\d{1,2})\b/i) || s.getName().match(/(\d{1,2})/);
    var n = m ? Number(m[1]) : -1;
    if (n >= 0 && n <= wk && n > bestN) { best = s; bestN = n; }
  });
  if (!best) best = sheets[sheets.length - 1];
  var lastRow = best.getLastRow(), lastCol = Math.min(best.getLastColumn(), 12);
  var vals = best.getRange(1, 1, lastRow, lastCol).getValues();
  var bgs = best.getRange(1, 1, lastRow, 2).getBackgrounds();
  var H = vals[0].map(kbaNorm_);
  var ix = function (names) { for (var i = 0; i < names.length; i++) { var j = H.indexOf(kbaNorm_(names[i])); if (j >= 0) return j; } for (var k = 0; k < H.length; k++) if (H[k].indexOf(kbaNorm_(names[0])) === 0) return k; return -1; };
  var cC = ix(['CODE']), cD = ix(['DES_DESIGNATION#1', 'DES DESIGNATION 1', 'DESIGNATION']), cCol = ix(['COL']), cUa = ix(['UA']), cPa = ix(['PRIX PRO']), cPv = ix(['PVTTC']), cCom = ix(['COMMENTAIRE']);
  if (cC < 0 || cD < 0) throw new Error('PVTTC : colonnes CODE / DESIGNATION introuvables (onglet ' + best.getName() + ')');
  var list = [], byCode = {};
  for (var r = 1; r < vals.length; r++) {
    var code = parseInt(vals[r][cC], 10); if (!(code > 0)) continue;
    var x = { code: code, des: String(vals[r][cD] || '').trim(), col: cCol >= 0 ? kbaNum_(vals[r][cCol]) : 0, ua: cUa >= 0 ? String(vals[r][cUa] || '').trim().toUpperCase() : '',
              pa: cPa >= 0 ? kbaNum_(vals[r][cPa]) : 0, pv: cPv >= 0 ? kbaNum_(vals[r][cPv]) : 0, com: cCom >= 0 ? String(vals[r][cCom] || '').trim() : '',
              red: kbaIsRed_(bgs[r][0]) || kbaIsRed_(bgs[r][1]) };
    list.push(x); byCode[code] = x;
  }
  return { tab: best.getName(), list: list, byCode: byCode };
}

function flAutoBestRungis_(des, PV, codeUsed) {
  var sc = PV.list.map(function (x) { return { code: x.code, des: x.des, sim: kbaSim_(des, x.des), used: !!codeUsed[x.code], red: x.red }; })
    .filter(function (x) { return x.sim > 0; })
    .sort(function (a, b) { return b.sim - a.sim; });
  var top = sc.slice(0, 4).map(function (x) { return { code: x.code, des: x.des, sim: Math.round(x.sim * 100), used: x.used }; });
  var sure = null;
  if (sc.length && sc[0].sim >= 0.999 && !sc[0].used && (sc.length < 2 || sc[1].sim < 0.999)) sure = PV.byCode[sc[0].code];
  return { sure: sure, top: top };
}

/* ============================ ADMIN (fiches produits) ============================ */
function flAutoGlobalOrders_(ddp) {
  var r = ddp.call('globalorders.fetch', [{}, { page: 1, fields: { distribution_date: 1, locales: 1, status: 1, title: 1 }, limit: 10, sort: { distribution_date: -1 } }]);
  return (r && r.items || []).map(function (g) {
    var d = g.distribution_date && g.distribution_date.$date ? new Date(g.distribution_date.$date) : new Date(g.distribution_date);
    g.day = Utilities.formatDate(d, KBA.TZ, 'yyyy-MM-dd'); return g;
  });
}

function flAutoFlCatId_(cats) {
  var c = (cats || []).filter(function (x) { return kbaNorm_(x.name) === KBA.FL_CAT_NAME; })[0];
  return c ? c._id : KBA.FL_CAT_ID;
}

/** v1.2 : fiches produits lues par paquets de 25, puis RELUES (paquets de 5, avec pause) si l'admin n'a pas répondu.
 *  Avant v1.2, une fiche non reçue (admin saturé) était prise pour « introuvable sur le site » → fausses alertes
 *  et nouvelles lignes jamais complétées (unité de vente, type, MU). errs reçoit { id: raison } des fiches restées illisibles. */
function flAutoFetchDetails_(ddp, ids, errs) {
  var out = {}, todo = ids.slice(), why = {};
  for (var pass = 0; pass < 3 && todo.length; pass++) {
    var size = pass === 0 ? 25 : 5, failed = [];
    if (pass) Utilities.sleep(2000 * pass);
    for (var i = 0; i < todo.length; i += size) {
      var chunk = todo.slice(i, i + size);
      var res = ddp.calls(chunk.map(function (id) { return ['producerproducts.fetchDetail', [{ producerproduct_id: id }]]; }));
      res.forEach(function (x, k) {
        var id = chunk[k];
        if (x && !x.error && x.result && x.result.producerproduct) { out[id] = x.result.producerproduct; return; }
        failed.push(id);
        why[id] = x && x.error ? String(x.error.reason || x.error.message || x.error.error || 'erreur')
                : (x && x.result ? 'réponse sans fiche produit' : 'pas de réponse');
      });
      if (pass) Utilities.sleep(300);
    }
    todo = failed;
  }
  if (errs) todo.forEach(function (id) { errs[id] = why[id]; });
  return out;
}

function flAutoFindSale_(des, saleFl, idUsed, row) {
  var n = kbaNorm_(des), hits = [];
  for (var id in saleFl) if (kbaNorm_(saleFl[id].product_name) === n && (!idUsed[id] || idUsed[id] === row)) hits.push(id);
  if (hits.length === 1) return hits[0];
  if (hits.length) return null;
  for (var id2 in saleFl) if (kbaSame_(des, saleFl[id2].product_name) && (!idUsed[id2] || idUsed[id2] === row)) hits.push(id2);
  return hits.length === 1 ? hits[0] : null;
}
/** Même produit : nom identique, ou mêmes mots significatifs dans les deux sens (« Grenade Bio 400g » = « Grenade BIO »). */
function kbaSame_(a, b) { return kbaNorm_(a) === kbaNorm_(b) || (kbaSim_(a, b) >= 0.999 && kbaSim_(b, a) >= 0.999); }

function flAutoSuggestSale_(des, saleFl, idUsed) {
  var a = [];
  for (var id in saleFl) { if (idUsed[id]) continue; var s = kbaSim_(des, saleFl[id].product_name); if (s > 0) a.push({ id: id, des: saleFl[id].product_name, prod: saleFl[id].producer_name, sim: Math.round(s * 100) }); }
  return a.sort(function (x, y) { return y.sim - x.sim; }).slice(0, 4);
}

function flAutoTypeOf_(tag, ua) {
  var t = tag.indexOf('piece') === 0 ? 'PIECE' : tag.indexOf('botte') === 0 ? 'BOTTE' : tag.indexOf('boite') === 0 ? 'BOITE'
        : tag.indexOf('paquet') === 0 ? 'PAQUET' : tag.indexOf('barquette') === 0 ? 'BARQUETTE' : tag.indexOf('sachet') === 0 ? 'SACHET' : (tag ? 'SACHET' : '');
  if (ua === 'PCE') return t === 'SACHET' ? 'INCOH' : t;            // acheté à la pièce : pas de mise en sachet
  if (t === 'BARQUETTE' || t === 'PAQUET') return 'SACHET';          // acheté au kilo → MU en barquette / paquet
  return t;
}

function flAutoPieces_(name) {
  var s = kbaNorm_(name);
  var m = s.match(/\bx\s*(\d{1,2})\b/) || s.match(/\blot de (\d{1,2})\b/);
  return m ? Number(m[1]) : 1;
}

function flAutoDay_(plus) { return Utilities.formatDate(new Date(Date.now() + plus * 86400000), KBA.TZ, 'yyyy-MM-dd'); }

/* ============================ PETITS OUTILS ============================ */
function kbaNorm_(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
var KBA_STOP = { bio: 1, kg: 1, pce: 1, piece: 1, botte: 1, sachet: 1, de: 1, du: 1, la: 1, le: 1, les: 1, g: 1, x: 1, et: 1, en: 1 };
function kbaTok_(s) { return kbaNorm_(s).split(' ').filter(function (w) { return w && !KBA_STOP[w] && !/^\d+g?$/.test(w); }); }
function kbaSim_(a, b) {
  var A = kbaTok_(a), B = kbaTok_(b);
  if (!A.length || !B.length) return 0;
  A = A.filter(function (w, i) { return A.indexOf(w) === i; }); B = B.filter(function (w, i) { return B.indexOf(w) === i; });
  var inter = A.filter(function (w) { return B.some(function (v) { return v === w || (w.length > 3 && v.length > 3 && (v.indexOf(w.slice(0, 5)) === 0 || w.indexOf(v.slice(0, 5)) === 0)); }); }).length;
  return inter / Math.max(A.length, B.length);
}
function kbaNum_(v) { var n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(n) ? 0 : n; }
function kbaEur_(n) { return (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €'; }
function kbaIsRed_(hex) {
  var m = String(hex || '').match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return false;
  var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return r >= 200 && g <= 90 && b <= 90;
}

/* ============================ CLIENT DDP (Meteor, SockJS xhr) ============================
 * admin.kelbongoo.com est une appli Meteor : les écrans appellent des « méthodes » serveur
 * (globalorders.fetch, globalorders.getGoppsQuantities, producerproducts.fetchDetail…).
 * Apps Script n'a pas de WebSocket : on parle le même protocole via le transport SockJS « xhr ».
 * Lecture seule : aucune méthode d'écriture n'est jamais appelée.
 */
function KbDdp_() {
  this.base = KBA.ADMIN + '/sockjs/' + (100 + Math.floor(Math.random() * 899)) + '/' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  this.cookies = {}; this.inbox = []; this.seq = 0;
}
KbDdp_.prototype._post = function (path, body) {
  var ck = Object.keys(this.cookies).map(function (k) { return k + '=' + this.cookies[k]; }, this).join('; ');
  var opt = { method: 'post', muteHttpExceptions: true, contentType: 'text/plain;charset=UTF-8', payload: body || '',
              headers: { 'Origin': KBA.ADMIN, 'Referer': KBA.ADMIN + '/', 'User-Agent': 'Mozilla/5.0 (KBG-FL-Auto)' } };
  if (ck) opt.headers.Cookie = ck;
  var resp = UrlFetchApp.fetch(this.base + path, opt);
  var h = resp.getAllHeaders()['Set-Cookie'];
  [].concat(h || []).forEach(function (c) { var p = String(c).split(';')[0]; var i = p.indexOf('='); if (i > 0) this.cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }, this);
  var code = resp.getResponseCode();
  if (code >= 400) throw new Error('admin.kelbongoo.com HTTP ' + code + (code === 403 ? ' (accès refusé — protection Cloudflare ?)' : ''));
  return resp.getContentText();
};
KbDdp_.prototype._recv = function () {
  var t = this._post('/xhr', '');
  var lines = String(t).split('\n');
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim(); if (!l) continue;
    var f = l.charAt(0);
    if (f === 'o' || f === 'h') continue;
    if (f === 'c') throw new Error('connexion admin fermée : ' + l);
    if (f === 'a') {
      var arr = JSON.parse(l.slice(1));
      for (var k = 0; k < arr.length; k++) {
        var m = JSON.parse(arr[k]);
        if (m.msg === 'ping') this._send([{ msg: 'pong', id: m.id }]);
        else this.inbox.push(m);
      }
    }
  }
};
KbDdp_.prototype._send = function (objs) {
  this._post('/xhr_send', JSON.stringify(objs.map(function (o) { return JSON.stringify(o); })));
};
KbDdp_.prototype.connect = function () {
  this._recv();                                                   // trame « o »
  this._send([{ msg: 'connect', version: '1', support: ['1', 'pre2', 'pre1'] }]);
  for (var i = 0; i < 6; i++) {
    this._recv();
    if (this.inbox.some(function (m) { return m.msg === 'connected'; })) { this.inbox = this.inbox.filter(function (m) { return m.msg !== 'connected'; }); return; }
    if (this.inbox.some(function (m) { return m.msg === 'failed'; })) throw new Error('DDP refusé (version)');
  }
  throw new Error('pas de réponse DDP de admin.kelbongoo.com');
};
KbDdp_.prototype.login = function () {
  var P = PropertiesService.getScriptProperties();
  var tok = P.getProperty('KBG_ADMIN_TOKEN'), em = P.getProperty('KBG_ADMIN_EMAIL'), pw = P.getProperty('KBG_ADMIN_PASS');
  var arg;
  if (em && pw) {
    var dig = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw, Utilities.Charset.UTF_8)
      .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
    arg = { user: em.indexOf('@') > 0 ? { email: em } : { username: em }, password: { digest: dig, algorithm: 'sha-256' } };
  } else if (tok) arg = { resume: tok };
  else throw new Error('identifiants admin absents : Propriétés du script KBG_ADMIN_EMAIL + KBG_ADMIN_PASS');
  var r = this.calls([['login', [arg]]])[0];
  if (r.error) throw new Error('connexion admin refusée : ' + (r.error.reason || r.error.message || r.error.error));
  return r.result;
};
KbDdp_.prototype.call = function (method, params) {
  var r = this.calls([[method, params]])[0];
  if (r.error) throw new Error(method + ' : ' + (r.error.reason || r.error.message || r.error.error));
  return r.result;
};
/** Plusieurs méthodes envoyées d'un coup ; renvoie [{result}|{error}] dans l'ordre. */
KbDdp_.prototype.calls = function (list) {
  var self = this, ids = list.map(function () { return 'k' + (++self.seq); });
  this._send(list.map(function (x, i) { return { msg: 'method', method: x[0], params: x[1] || [], id: ids[i] }; }));
  var got = {}, left = ids.length, t0 = Date.now();
  while (left > 0) {
    if (Date.now() - t0 > 120000) throw new Error('délai dépassé (admin.kelbongoo.com)');
    this._recv();
    var keep = [];
    this.inbox.forEach(function (m) {
      if (m.msg === 'result' && ids.indexOf(m.id) >= 0 && !got[m.id]) { got[m.id] = m; left--; }
      else if (m.msg !== 'updated' && m.msg !== 'added' && m.msg !== 'changed' && m.msg !== 'removed' && m.msg !== 'ready') keep.push(m);
    });
    this.inbox = keep.slice(-50);
  }
  return ids.map(function (id) { return got[id]; });
};

/* ============================ MISE EN FORME « COMMANDE FL » (v1.1) ============================
 * À exécuter une fois (relançable sans risque). Ne déplace, ne renomme et ne supprime AUCUNE colonne :
 * l'appli Kelbongoo et les scripts lisent les colonnes par leur nom d'en-tête en ligne 1.
 *  1. Sauvegarde : copie complète du fichier « COMMANDE FL — sauvegarde avant mise en forme AAAA-MM-JJ HHhMM ».
 *  2. Tri : produits actifs en haut, puis par producteur et désignation (formules de ligne conservées).
 *  3. En-têtes colorés par rôle + note d'explication sur chaque en-tête (qui remplit, comment c'est calculé).
 *  4. Formats (prix en €, MU en kg, quantités), largeurs, ligne 1 + 2 premières colonnes figées.
 *  5. Couleurs conditionnelles : Non actif grisé, colis à commander en vert, infos manquantes en rouge.
 *  6. Avertissement (pas de blocage) si on modifie à la main une colonne remplie automatiquement.
 *  7. Onglet « 📖 MODE D'EMPLOI » + onglets techniques rangés à la fin.
 */
var KBA_GROUPS = {
  site:   { bg: '#1565c0', soft: null,      lbl: 'SITE (auto)' },
  rungis: { bg: '#6a1b9a', soft: null,      lbl: 'RUNGIS PVTTC (auto)' },
  matin:  { bg: '#00838f', soft: '#e0f7fa', lbl: 'VENTES (auto 4h30)' },
  stock:  { bg: '#ef6c00', soft: '#fff3e0', lbl: 'STOCK PDP' },
  calcul: { bg: '#558b2f', soft: '#f1f8e9', lbl: 'CALCUL' },
  cmd:    { bg: '#1b5e20', soft: '#e8f5e9', lbl: 'À COMMANDER' },
  actif:  { bg: '#37474f', soft: null,      lbl: 'ACTIF' }
};
var KBA_COLS = [
  ['PRODUCTEUR',              'site',   190, '@',          'Producteur — rempli automatiquement depuis la fiche produit du site Kelbongoo.'],
  ['DESIGNATION',             'site',   270, '@',          'Nom du produit sur le site — automatique. Ne pas modifier à la main : l\'appli et les scripts s\'en servent.'],
  ['CODE PROBON',             'rungis',  75, '0',          'Code Rungis (PVTTC). Automatique si le nom correspond ; sinon à choisir dans l\'appli (Master › Fruits & légumes › Contrôle auto).'],
  ['COMMANDE A 5H',           'matin',   90, '0',          'Nombre vendu pour la distribution de DEMAIN. Rempli automatiquement vers 4h30 depuis admin.kelbongoo.com — plus besoin de le saisir.'],
  ['COMMANDE PROBON (colis)', 'cmd',    115, '0.0',        'COLIS À COMMANDER = BESOIN (colis) − STOCK CAGETTE. En vert quand il faut commander.'],
  ['COL',                     'rungis',  60, '0.##',       'Colisage Rungis (kg ou pièces par colis) — automatique depuis PVTTC.'],
  ['ESTIMATION MU',           'matin',   95, '0',          'Unités à préparer = COMMANDE A 5H × 1,15 (les commandes restent ouvertes jusqu\'à 10h).'],
  ['STOCK MU',                'stock',   80, '0',          'Unités déjà mises en sachet / prêtes à PDP (inventaire de l\'appli, modifiable).'],
  ['STOCK CAGETTE',           'stock',   90, '0.##',       'Colis entiers en stock à PDP (inventaire de l\'appli, modifiable).'],
  ['UNITE DE VENTE',          'site',   150, '@',          'Unité vendue au client avec sa fourchette de poids, ex. « sachet (450g-550g) » — automatique (site).'],
  ['TYPE',                    'site',    85, '@',          'SACHET = mise en unité (MU) à faire · PIECE · BOTTE · PAQUET — automatique (site + unité d\'achat Rungis).'],
  ['MU EN KILO',              'site',    80, '0.###',      'Une unité vendue = X kg (achat au kilo chez Rungis) ou X pièces (achat à la pièce) — automatique.'],
  ['PRIX ACHAT HT',           'rungis',  90, '0.00 "€"',   'Prix Rungis HT par kg ou par pièce (UA) — automatique depuis PVTTC.'],
  ['PRIX VENTE TTC',          'rungis',  90, '0.00 "€"',   'PVTTC Rungis par kg ou par pièce — automatique. Les écarts avec le prix du site sont signalés dans l\'appli.'],
  ['BESOIN (uv)',             'calcul',  85, '0.##',       'Besoin en kg ou en pièces = (ESTIMATION MU − STOCK MU) × MU EN KILO.'],
  ['BESOIN (colis)',          'calcul',  85, '0.0',        'Besoin en colis = BESOIN (uv) ÷ COL.'],
  ['ACTIF ?',                 'actif',   90, '@',          'Actif / Non actif. Un produit rouge chez Rungis est proposé « Non actif » dans l\'appli.'],
  ['ID SITE KBG',             'site',   200, '@',          'Identifiant du produit sur le site (lien appli ↔ Sheet) — automatique. Ne pas modifier.']
];
var KBA_AUTO_WARN = ['PRODUCTEUR', 'DESIGNATION', 'COMMANDE A 5H', 'UNITE DE VENTE', 'TYPE', 'MU EN KILO', 'PRIX ACHAT HT', 'PRIX VENTE TTC', 'COL', 'ID SITE KBG'];

function flMiseEnForme() {
  var lock = LockService.getScriptLock(); lock.waitLock(60000);
  try {
    var ss = SpreadsheetApp.openById(KBA.FL_SS_ID);
    var sh = ss.getSheetByName(KBA.FL_TAB);
    if (!sh) throw new Error('onglet ' + KBA.FL_TAB + ' introuvable');

    // 1. sauvegarde
    var stamp = Utilities.formatDate(new Date(), KBA.TZ, 'yyyy-MM-dd HH\'h\'mm');
    var file = DriveApp.getFileById(KBA.FL_SS_ID);
    var parents = file.getParents();
    var backup = parents.hasNext() ? file.makeCopy('COMMANDE FL — sauvegarde avant mise en forme ' + stamp, parents.next())
                                   : file.makeCopy('COMMANDE FL — sauvegarde avant mise en forme ' + stamp);
    Logger.log('Sauvegarde : ' + backup.getUrl());

    var T = flAutoReadTable_(sh), C = T.cols;
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(kbaNorm_);
    var colOf = function (name) { return head.indexOf(kbaNorm_(name)) + 1; };       // 1-based, 0 = absent
    var lastData = 1; T.rows.forEach(function (r) { if (r.des) lastData = Math.max(lastData, r.row); });
    var lastCol = sh.getLastColumn(), maxRows = sh.getMaxRows();

    // 2. tri : Actif d'abord, puis producteur, désignation
    if (lastData > 2 && C.actif >= 0 && C.prod >= 0 && C.des >= 0) {
      sh.getRange(2, 1, lastData - 1, lastCol).sort([{ column: C.actif + 1, ascending: true }, { column: C.prod + 1, ascending: true }, { column: C.des + 1, ascending: true }]);
    }
    var nAct = 0; sh.getRange(2, C.actif + 1, lastData - 1, 1).getValues().forEach(function (v) { if (/^actif/i.test(String(v[0]).trim())) nAct++; });

    // 3-4. en-têtes, notes, formats, largeurs
    sh.setFrozenRows(1); sh.setFrozenColumns(2);
    sh.setRowHeight(1, 54);
    var hdr = sh.getRange(1, 1, 1, lastCol);
    hdr.setFontWeight('bold').setFontColor('#ffffff').setFontSize(10).setWrap(true).setHorizontalAlignment('center').setVerticalAlignment('middle').setBackground('#9e9e9e');
    KBA_COLS.forEach(function (d) {
      var c = colOf(d[0]); if (!c) return;
      var g = KBA_GROUPS[d[1]];
      sh.getRange(1, c).setBackground(g.bg).setNote(g.lbl + '\n' + d[4]);
      sh.setColumnWidth(c, d[2]);
      var body = sh.getRange(2, c, maxRows - 1, 1);
      body.setNumberFormat(d[3]);
      body.setBackground(g.soft);                                   // fond doux pour les zones du matin / stock / calcul / commande
      if (d[0] === 'COMMANDE PROBON (colis)') body.setFontWeight('bold').setFontSize(12).setHorizontalAlignment('center');
      else if (d[1] !== 'site' || d[0] === 'TYPE') body.setHorizontalAlignment('center');
    });
    var cDes = colOf('DESIGNATION'); if (cDes) sh.getRange(2, cDes, maxRows - 1, 1).setFontWeight('bold');
    sh.getRange(2, 1, maxRows - 1, lastCol).setVerticalAlignment('middle').setFontFamily('Arial');
    if (lastData >= 2) sh.setRowHeights(2, lastData - 1, 26);
    for (var x = 19; x <= lastCol; x++) sh.setColumnWidth(x, 30);  // colonnes vides après ID SITE KBG

    // séparation actifs / non actifs (bordure épaisse sous le dernier actif)
    sh.getRange(2, 1, maxRows - 1, Math.min(18, lastCol)).setBorder(false, false, false, false, false, false);
    if (nAct >= 1) sh.getRange(nAct + 1, 1, 1, Math.min(18, lastCol)).setBorder(null, null, true, null, null, null, '#37474f', SpreadsheetApp.BorderStyle.SOLID_THICK);

    // ID SITE KBG replié (groupe de colonnes) — reste lisible par l'appli
    var cId = colOf('ID SITE KBG');
    if (cId && sh.getColumnGroupDepth(cId) === 0) { sh.getRange(1, cId, 1, 1).shiftColumnGroupDepth(1); try { sh.getColumnGroup(cId, 1).collapse(); } catch (e) {} }

    // 5. mise en forme conditionnelle (reconstruite)
    var L = function (c) { return String.fromCharCode(64 + c); };      // colonnes A..Z
    var cAct = colOf('ACTIF ?'), cCmd = colOf('COMMANDE PROBON (colis)'), cD = colOf('COMMANDE A 5H');
    var cType = colOf('TYPE'), cMu = colOf('MU EN KILO'), cCol = colOf('COL'), cUv = colOf('UNITE DE VENTE');
    var all = sh.getRange(2, 1, maxRows - 1, Math.min(18, lastCol));
    var rules = [];
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + L(cAct) + '2="Non actif"')
      .setBackground('#eeeeee').setFontColor('#9e9e9e').setRanges([all]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($' + L(cAct) + '2="Actif",N($' + L(cCmd) + '2)>0)')
      .setBackground('#a5d6a7').setFontColor('#1b5e20').setBold(true).setRanges([sh.getRange(2, cCmd, maxRows - 1, 1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($' + L(cAct) + '2="Actif",N($' + L(cD) + '2)>0)')
      .setBold(true).setFontColor('#006064').setRanges([sh.getRange(2, cD, maxRows - 1, 1)]).build());
    [cType, cMu, cCol, cUv].forEach(function (c) {
      if (!c) return;
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($' + L(cAct) + '2="Actif",$' + L(c) + '2="")')
        .setBackground('#ffcdd2').setRanges([sh.getRange(2, c, maxRows - 1, 1)]).build());
    });
    sh.setConditionalFormatRules(rules);
    sh.getRange(2, cAct, maxRows - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Actif', 'Non actif'], true).setAllowInvalid(false).build());

    // 6. avertissement sur les colonnes automatiques (n'empêche rien, n'affecte pas les scripts)
    sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) { if (/^KBG auto/.test(p.getDescription())) p.remove(); });
    KBA_AUTO_WARN.forEach(function (n) {
      var c = colOf(n); if (!c) return;
      var p = sh.getRange(2, c, maxRows - 1, 1).protect().setDescription('KBG auto — ' + n);
      p.setWarningOnly(true);
    });

    // 7. onglets : COMMANDE FL d'abord (vert), mode d'emploi, puis le reste ; techniques en gris à la fin
    sh.setTabColor('#2e7d32');
    var guide = flMiseEnFormeGuide_(ss);
    var order = [KBA.FL_TAB, guide.getName(), 'DEMANDES RAJOUT FL', 'HISTORIQUE INVENTAIRE FL', KBA.REPORT_TAB, KBA.LOG_TAB, 'FL_A_VERIFIER', 'unique prod'];
    var pos = 1;
    order.forEach(function (n) { var t = ss.getSheetByName(n); if (!t) return; ss.setActiveSheet(t); ss.moveActiveSheet(pos++); });
    [KBA.REPORT_TAB, KBA.LOG_TAB, 'FL_A_VERIFIER', 'unique prod'].forEach(function (n) { var t = ss.getSheetByName(n); if (t) t.setTabColor('#9e9e9e'); });
    ss.setActiveSheet(sh);

    // les numéros de ligne ont changé (tri) → rapport de l'appli à refaire
    flAutoSchedule_('controle');
    Logger.log('Mise en forme OK — ' + nAct + ' produits actifs en haut. Sauvegarde : ' + backup.getUrl());
    return { ok: true, actifs: nAct, backup: backup.getUrl() };
  } finally { lock.releaseLock(); }
}

function flMiseEnFormeGuide_(ss) {
  var name = '📖 MODE D\'EMPLOI';
  var g = ss.getSheetByName(name) || ss.insertSheet(name);
  g.clear();
  var rows = [
    ['📖 COMMANDE FL KBG x PROBON — mode d\'emploi', ''],
    ['', ''],
    ['Chaque jour', ''],
    ['≈ 4h30', 'Les ventes de la distribution de DEMAIN sont écrites seules dans COMMANDE A 5H (lues sur admin.kelbongoo.com).'],
    ['5h', 'Rungis lit la colonne verte COMMANDE PROBON (colis) : c\'est le nombre de colis à commander par produit.'],
    ['10h', 'Fin des commandes clients : ESTIMATION MU contient déjà +15 % pour les commandes passées après 5h.'],
    ['Soir', 'L\'inventaire de l\'appli met à jour STOCK MU et STOCK CAGETTE.'],
    ['', ''],
    ['Couleurs des en-têtes', ''],
    ['Bleu', 'SITE — rempli automatiquement depuis la fiche produit du site (désignation, unité de vente, type, MU, ID).'],
    ['Violet', 'RUNGIS — rempli automatiquement depuis le fichier PVTTC (code, colisage, prix).'],
    ['Turquoise', 'VENTES — rempli automatiquement à 4h30 (COMMANDE A 5H) et estimation (+15 %).'],
    ['Orange', 'STOCK PDP — inventaire (modifiable).'],
    ['Vert clair', 'CALCULS — besoin en kg / pièces et en colis.'],
    ['Vert foncé', 'À COMMANDER — colis à commander chez Rungis (cellule verte = commander).'],
    ['', ''],
    ['Lignes', ''],
    ['Haut', 'Produits ACTIFS (triés par producteur). Une ligne épaisse les sépare des Non actifs.'],
    ['Grisé', 'Produit Non actif : rien à commander.'],
    ['Rouge', 'Information manquante (type, MU, colisage, unité de vente) : à régler dans l\'appli Master › Fruits & légumes.'],
    ['', ''],
    ['Règles', ''],
    ['Ne pas', 'renommer, déplacer ou supprimer une colonne : l\'appli Kelbongoo lit les colonnes par leur nom.'],
    ['Ne pas', 'modifier à la main les colonnes automatiques (un avertissement s\'affiche) : la valeur serait réécrite au prochain contrôle.'],
    ['Décisions', 'Concordances Rungis, produits rouges, absents, écarts de prix : appli Kelbongoo › Master › 🥬 Fruits & légumes › 🤖 Contrôle auto.'],
    ['Journal', 'Toute modification automatique est notée dans l\'onglet FL_AUTO_LOG (avant → après).']
  ];
  g.getRange(1, 1, rows.length, 2).setValues(rows).setFontFamily('Arial').setFontSize(12).setVerticalAlignment('middle').setWrap(true);
  g.setColumnWidth(1, 150); g.setColumnWidth(2, 760);
  g.getRange(1, 1, 1, 2).merge().setFontSize(18).setFontWeight('bold').setFontColor('#ffffff').setBackground('#2e7d32');
  g.setRowHeight(1, 44);
  [3, 9, 17, 22].forEach(function (r) { g.getRange(r, 1, 1, 2).setFontWeight('bold').setFontSize(14).setBackground('#e8f5e9'); });
  var sw = { 10: '#1565c0', 11: '#6a1b9a', 12: '#00838f', 13: '#ef6c00', 14: '#558b2f', 15: '#1b5e20' };
  Object.keys(sw).forEach(function (r) { g.getRange(Number(r), 1).setBackground(sw[r]).setFontColor('#ffffff').setFontWeight('bold'); });
  g.getRange(19, 1).setBackground('#eeeeee').setFontColor('#9e9e9e');
  g.getRange(20, 1).setBackground('#ffcdd2');
  g.getRange(23, 1, 2, 1).setFontColor('#c62828').setFontWeight('bold');
  g.setTabColor('#fbc02d');
  return g;
}

/** v1.2 — Diagnostic : relit les fiches produits de toutes les lignes ACTIVES et écrit dans le journal
 *  combien sont lues / illisibles (avec la raison donnée par l'admin). N'écrit rien dans le Sheet. */
function flAutoDiagFiches() {
  var sh = SpreadsheetApp.openById(KBA.FL_SS_ID).getSheetByName(KBA.FL_TAB);
  var T = flAutoReadTable_(sh);
  var act = T.rows.filter(function (r) { return r.des && r.actifOk && r.id; });
  var ddp = new KbDdp_(); ddp.connect(); ddp.login();
  var errs = {};
  var PP = flAutoFetchDetails_(ddp, act.map(function (r) { return r.id; }), errs);
  Logger.log('Lignes actives avec ID : ' + act.length + ' · fiches lues : ' + Object.keys(PP).length + ' · illisibles : ' + Object.keys(errs).length);
  act.forEach(function (r) { if (errs[r.id]) Logger.log('  ligne ' + r.row + ' · ' + r.des + ' · ' + r.id + ' → ' + errs[r.id]); });
  act.filter(function (r) { return PP[r.id]; }).slice(0, 3).forEach(function (r) {
    var p = PP[r.id]; Logger.log('  OK ligne ' + r.row + ' · ' + p.product_name + ' · unité ' + (p.unit_display || '?') + ' · poids ' + (p.unit_weight || '?') + ' · actif ' + p.active);
  });
}
