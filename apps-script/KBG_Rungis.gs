/**
 * KBG_Rungis.gs — v1.3 (19/10/2026) — à ajouter dans le projet Apps Script « FL_Probon_Proxy »
 * ---------------------------------------------------------------------------------------------
 * 1. 5h00 : mail « Commande KBG <date> » à gestion@probon.fr
 *      - corps : CODE PROBON · PRODUCTEUR · DÉSIGNATION · COLIS (gros, lisible)
 *      - pièce jointe : Sheet complet « Commande KBG JJ-MM-AAAA » (.xlsx) + lien Google Sheet
 *      - + ajouts Rungis demandés la veille au soir (après la prépa), à livrer avec cette commande
 *      - photo de la commande gardée dans l'onglet « COMMANDES 5H » (lue par l'Espace Rungis)
 * 2. Espace Rungis (appli) : action rungis_cmd_get → commande 5h du jour + rajouts de dernière minute
 * 3. Chauffeur (appli) : action rungis_alert → mail « Palette non récupérée » à rr@ / gestion@ / hg@
 * 4. Chauffeur (appli) : action rungis_driver_check → lit le REGISTRE APPLI PRIBON, colonne « Retour PDP » (N)
 *
 * v1.1 : ajouts Rungis (onglet DEMANDES RAJOUT FL, « Date distrib » = jour de la commande) dans le mail 5h et
 *        l'Espace Rungis ; commande envoyée + commande en cours ; plus de mention « fin des commandes 10h ».
 *
 * Les actions rungis_* arrivent par kbgProxy (cible « fl », secret ajouté par le serveur) ou par la Cloud
 * Function kbgRungis (Espace Rungis achat@ / gestion@). Dans Code.gs › doPost, APRÈS la vérification du secret, ajouter UNE ligne :
 *     if (String(p.action || '').indexOf('rungis_') === 0) return kbRungisRoute_(p);
 *
 * Installation : coller ce fichier → exécuter rungisTest (mail d'essai à hg@ seulement)
 *               → exécuter rungisInstall (déclencheur 5h) → Gérer les déploiements › crayon › Nouvelle version.
 * Aucune colonne de COMMANDE FL n'est modifiée : lecture seule, par nom d'en-tête.
 */

var RG_SHEET_ID   = '1PXQU4QP_bh_sRCEHonrMM7FkWmJWtNPyxDBPPRBlNVQ';
var RG_TAB        = 'COMMANDE FL';
var RG_SNAP_TAB   = 'COMMANDES 5H';
var RG_RAJ_TAB    = 'DEMANDES RAJOUT FL';
var RG_ALERT_TAB  = 'RUNGIS ALERTES';
var RG_TO         = 'gestion@probon.fr';
var RG_FAIL_TO    = 'hg@probon.fr';
var RG_ALERT_TO   = 'rr@pribon.org, gestion@probon.fr, hg@probon.fr';
var RG_TZ         = 'Europe/Paris';
var RG_DAYS       = [2, 3, 4, 5];          // mardi → vendredi (distributions du mercredi au samedi)
var RG_FOLDER_NAME = 'Commandes KBG Rungis'; // créé à côté du Sheet COMMANDE FL au 1er envoi
var RG_REGISTRE_ID = '1iRaJurZfyf27_IOcCdD-XdgcQsCV2ogMDcFlBl_mUog'; // REGISTRE APPLI PRIBON (onglet Salariés)
var RG_JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
var RG_MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// ───────────────────────── utilitaires ─────────────────────────
function rgNorm_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}
function rgNum_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var s = String(v == null ? '' : v).replace(/[€\s  ]/g, '').replace(',', '.');
  var n = parseFloat(s); return isFinite(n) ? n : 0;
}
function rgIso_(d) { return Utilities.formatDate(d, RG_TZ, 'yyyy-MM-dd'); }
function rgFr_(iso) { var p = String(iso).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso); }
function rgLong_(iso) {
  var p = String(iso).split('-'); var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
  return RG_JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + RG_MOIS[d.getMonth()];
}
function rgAddDays_(iso, n) {
  var p = String(iso).split('-'); var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
  d.setDate(d.getDate() + n); return rgIso_(d);
}
function rgDow_(iso) { var p = String(iso).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12).getDay(); }
function rgEsc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function rgFmt_(n, dec) { var x = Math.round(Number(n || 0) * Math.pow(10, dec)) / Math.pow(10, dec); return String(x).replace('.', ','); }
function rgJson_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// Lit COMMANDE FL par nom d'en-tête (jamais par position)
function rgReadFL_() {
  var sh = SpreadsheetApp.openById(RG_SHEET_ID).getSheetByName(RG_TAB);
  if (!sh) throw new Error('Onglet « ' + RG_TAB + ' » introuvable');
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return { rows: [], sheet: sh, head: {} };
  var head = {}; v[0].forEach(function (h, i) { var k = rgNorm_(h); if (k && head[k] == null) head[k] = i; });
  function col(names) { for (var i = 0; i < names.length; i++) { var k = rgNorm_(names[i]); if (head[k] != null) return head[k]; } return -1; }
  var C = {
    producteur: col(['PRODUCTEUR']), designation: col(['DESIGNATION']), code: col(['CODE PROBON']),
    cmd5h: col(['COMMANDE A 5H']), colis: col(['COMMANDE PROBON (colis)', 'COMMANDE PROBON']), col: col(['COL', 'COLISAGE']),
    estim: col(['ESTIMATION MU']), stockMu: col(['STOCK MU']), stockCag: col(['STOCK CAGETTE']),
    uv: col(['UNITE DE VENTE']), type: col(['TYPE']), mu: col(['MU EN KILO']),
    pa: col(['PRIX ACHAT HT']), pv: col(['PRIX VENTE TTC']), besoinUv: col(['BESOIN (uv)']), besoinColis: col(['BESOIN (colis)']),
    actif: col(['ACTIF ?', 'ACTIF']), id: col(['ID SITE KBG'])
  };
  if (C.designation < 0 || C.colis < 0) throw new Error('En-têtes DESIGNATION / COMMANDE PROBON (colis) introuvables');
  function g(r, k) { return C[k] >= 0 ? r[C[k]] : ''; }
  var rows = [];
  for (var i = 1; i < v.length; i++) {
    var r = v[i];
    var des = String(g(r, 'designation') || '').trim(); if (!des) continue;
    rows.push({
      line: i + 1, producteur: String(g(r, 'producteur') || '').trim(), designation: des, code: String(g(r, 'code') || '').trim(),
      cmd5h: rgNum_(g(r, 'cmd5h')), colis: rgNum_(g(r, 'colis')), col: rgNum_(g(r, 'col')), estim: rgNum_(g(r, 'estim')),
      stockMu: rgNum_(g(r, 'stockMu')), stockCag: rgNum_(g(r, 'stockCag')), uv: String(g(r, 'uv') || '').trim(),
      type: String(g(r, 'type') || '').trim(), mu: rgNum_(g(r, 'mu')), pa: rgNum_(g(r, 'pa')), pv: rgNum_(g(r, 'pv')),
      besoinUv: rgNum_(g(r, 'besoinUv')), actif: rgNorm_(g(r, 'actif')) === 'ACTIF', id: String(g(r, 'id') || '').trim()
    });
  }
  var note = '';
  try { if (C.cmd5h >= 0) note = String(sh.getRange(1, C.cmd5h + 1).getNote() || ''); } catch (e) {}
  return { rows: rows, sheet: sh, head: C, note5h: note };
}

// Lignes à commander : produit Actif avec des colis > 0
function rgBuildOrder_(fl) {
  return fl.rows.filter(function (r) { return r.actif && r.colis > 0; })
    .map(function (r) { r.colis = Math.round(r.colis * 10) / 10; r.totalHt = Math.round(r.colis * (r.col || 0) * (r.pa || 0) * 100) / 100; return r; })
    .sort(function (a, b) { return a.producteur.localeCompare(b.producteur, 'fr') || a.designation.localeCompare(b.designation, 'fr'); });
}

function rgFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('RUNGIS_CMD_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var parents = DriveApp.getFileById(RG_SHEET_ID).getParents();
  var parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  var it = parent.getFoldersByName(RG_FOLDER_NAME);
  var f = it.hasNext() ? it.next() : parent.createFolder(RG_FOLDER_NAME);
  props.setProperty('RUNGIS_CMD_FOLDER_ID', f.getId());
  return f;
}

// ───────────────────────── Sheet « Commande KBG <date> » ─────────────────────────
function rgCreateSheet_(day, distrib, rows, warn, ajouts) {
  var title = 'Commande KBG ' + rgFr_(day).replace(/\//g, '-');
  var folder = rgFolder_();
  var old = folder.getFilesByName(title);
  while (old.hasNext()) old.next().setTrashed(true); // relance du jour : on remplace
  var ss = SpreadsheetApp.create(title);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  var sh = ss.getSheets()[0]; sh.setName('Commande');
  var head = ['CODE PROBON', 'PRODUCTEUR', 'DÉSIGNATION', 'COLIS À COMMANDER', 'COLISAGE (kg ou pièces / colis)', 'UNITÉ DE VENTE KBG', 'TYPE', 'PRIX ACHAT HT (€/kg ou €/pce)', 'TOTAL HT ESTIMÉ (€)', 'VENTES À 5H', 'ESTIMATION MU (+15 %)', 'STOCK MU', 'STOCK CAGETTE', 'BESOIN (uv)', 'ID SITE KBG'];
  var data = [head];
  rows.forEach(function (r) {
    data.push([r.code, r.producteur, r.designation, r.colis, r.col || '', r.uv, r.type, r.pa || '', r.totalHt || '', r.cmd5h || 0, r.estim || 0, r.stockMu || 0, r.stockCag || 0, r.besoinUv || 0, r.id]);
  });
  var n = data.length;
  sh.getRange(1, 1, n, head.length).setValues(data);
  var tot = rows.reduce(function (a, r) { return a + r.colis; }, 0), totHt = rows.reduce(function (a, r) { return a + (r.totalHt || 0); }, 0);
  sh.getRange(n + 1, 1, 1, head.length).setValues([['', '', 'TOTAL', Math.round(tot * 10) / 10, '', '', '', '', Math.round(totHt * 100) / 100, '', '', '', '', '', '']]).setFontWeight('bold').setBackground('#e8f5e9');
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setFontColor('#ffffff').setBackground('#1a4d2e').setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(1, 42);
  sh.getRange(2, 4, Math.max(1, n - 1), 1).setFontWeight('bold').setFontSize(13).setBackground('#c8e6c9').setNumberFormat('0.0');
  sh.getRange(2, 8, Math.max(1, n), 2).setNumberFormat('#,##0.00 €');
  sh.setFrozenRows(1); sh.setFrozenColumns(3);
  sh.setColumnWidth(1, 95); sh.setColumnWidth(2, 210); sh.setColumnWidth(3, 280); sh.setColumnWidth(4, 110);
  for (var c = 5; c <= head.length; c++) sh.setColumnWidth(c, 115);
  sh.setColumnWidth(15, 210);
  if (n > 1) sh.getRange(1, 1, n, head.length).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
  rows.forEach(function (r, i) { if (r.hors) sh.getRange(i + 2, 1, 1, head.length).setBackground('#ffe0b2').setFontWeight('bold'); });
  var aj = ss.insertSheet('Ajouts Rungis');
  var ah = ['CODE PROBON', 'PRODUCTEUR', 'DÉSIGNATION', 'COLIS AJOUTÉS', 'COLISAGE', 'PRIX ACHAT HT', 'TOTAL HT ESTIMÉ', 'MANQUE (uv)', 'DEMANDÉ LE', 'PAR'];
  var ad = [ah].concat((ajouts || []).map(function (r) { return [r.code, r.producteur, r.designation, r.colis, r.col, r.pa, r.totalHt, r.manque, r.at, r.by]; }));
  aj.getRange(1, 1, ad.length, ah.length).setValues(ad);
  aj.getRange(1, 1, 1, ah.length).setFontWeight('bold').setFontColor('#ffffff').setBackground('#e65100');
  aj.setFrozenRows(1); aj.setColumnWidth(2, 210); aj.setColumnWidth(3, 280);
  if (!(ajouts || []).length) aj.getRange(2, 1).setValue('Aucun ajout pour cette commande (pas de prépa la veille ou rien à rajouter).');
  var info = ss.insertSheet('Infos');
  info.getRange(1, 1, 8, 2).setValues([
    ['Commande KBG pour la prépa du', rgLong_(day)],
    ['Distribution du', rgLong_(distrib)],
    ['Produits', rows.length],
    ['Colis à commander', Math.round(tot * 10) / 10],
    ['Total HT estimé', Math.round(totHt * 100) / 100],
    ['Ajouts Rungis (colis)', Math.round((ajouts || []).reduce(function (a, r) { return a + (r.colis || 0); }, 0) * 10) / 10],
    ['Généré le', Utilities.formatDate(new Date(), RG_TZ, 'dd/MM/yyyy HH:mm')],
    ['Contrôle', warn || 'OK — ventes 5h remplies automatiquement']
  ]);
  info.getRange(1, 1, 8, 1).setFontWeight('bold'); info.setColumnWidth(1, 230); info.setColumnWidth(2, 520);
  info.getRange(5, 2).setNumberFormat('#,##0.00 €');
  SpreadsheetApp.flush();
  return ss;
}

function rgXlsxBlob_(ss, name) {
  var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
  var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Export xlsx HTTP ' + res.getResponseCode());
  return res.getBlob().setName(name + '.xlsx');
}

// ───────────────────────── v1.3 : produits vendus absents du Sheet ─────────────────────────
var RG_HORS_TXT = 'PAS dans le Sheet COMMANDE FL — demander à Raimbaud de mettre à jour';
/** Produits vendus pour « distrib » sans ligne active dans COMMANDE FL (relevé de 4h30, meta FL Auto) → lignes de commande.
 *  Si le code est déjà commandé, on n'ajoute pas de doublon. colis inconnu (pas de colisage / MU) → 0 + « quantité à confirmer ». */
function rgHors_(distrib, rows) {
  var m = {}; try { m = JSON.parse(PropertiesService.getScriptProperties().getProperty('FL_AUTO_META') || '{}'); } catch (e) {}
  var v = m.ventes && m.ventes.day === distrib ? m.ventes : (m.veille && m.veille.day === distrib ? m.veille : null);
  if (!v || !(v.soldMissing || []).length) return [];
  var have = {}; (rows || []).forEach(function (r) { if (r.code) have[String(r.code)] = 1; });
  return v.soldMissing.filter(function (x) { return !x.code || !have[String(x.code)]; }).map(function (x) {
    var colis = x.colis != null ? Number(x.colis) : 0;
    return {
      hors: true, code: String(x.code || ''), producteur: x.prod || '', colis: colis, col: x.col || 0, pa: x.pa || 0,
      designation: x.des + ' ⚠️ ' + RG_HORS_TXT + (x.colis == null ? ' (quantité à confirmer : ' + x.n + ' vendus)' : ''),
      totalHt: Math.round(colis * (x.col || 0) * (x.pa || 0) * 100) / 100, cmd5h: x.n, estim: x.estim, stockMu: 0, stockCag: 0,
      besoinUv: x.estim, uv: '', type: '', id: x.id, n: x.n, actif: false
    };
  }).sort(function (a, b) { return a.producteur.localeCompare(b.producteur, 'fr') || a.designation.localeCompare(b.designation, 'fr'); });
}
function rgHorsHtml_(rows) {
  var h = rows.filter(function (r) { return r.hors; });
  if (!h.length) return '';
  return '<div style="margin-top:10px;background:#fff3e0;border:3px solid #ef6c00;border-radius:12px;padding:10px 14px;font-size:15px;color:#7a4100">'
    + '<b style="font-size:17px">⚠️ ' + h.length + ' produit(s) vendu(s) mais PAS dans le Sheet COMMANDE FL</b><br>'
    + 'Ils sont quand même dans la liste ci-dessous (ligne orange). <b>Demander à Raimbaud de mettre à jour le Sheet.</b></div>';
}

// ───────────────────────── Mail 5h ─────────────────────────
function rgMailHtml_(day, distrib, rows, url, warn, ajouts) {
  var tot = rows.reduce(function (a, r) { return a + r.colis; }, 0);
  var box = function (lbl, val, col) { return '<td style="padding:5px"><div style="background:' + col + '14;border-left:8px solid ' + col + ';border-radius:12px;padding:10px 14px"><div style="font-size:13px;color:#555">' + lbl + '</div><div style="font-size:34px;font-weight:900;color:' + col + ';line-height:1.1">' + val + '</div></div></td>'; };
  var lines = rows.map(function (r, i) {
    return '<tr style="background:' + (r.hors ? '#fff3e0' : (i % 2 ? '#f6faf6' : '#ffffff')) + '">'
      + '<td style="padding:10px 10px;border-bottom:1px solid #e3ebe3;font-size:18px;font-weight:900;color:#1a4d2e;white-space:nowrap">' + rgEsc_(r.code || '—') + '</td>'
      + '<td style="padding:10px 10px;border-bottom:1px solid #e3ebe3;font-size:13px;color:#555">' + rgEsc_(r.producteur) + '</td>'
      + '<td style="padding:10px 10px;border-bottom:1px solid #e3ebe3;font-size:16px;font-weight:700">' + rgEsc_(r.designation) + '</td>'
      + '<td style="padding:10px 12px;border-bottom:1px solid #e3ebe3;text-align:right;white-space:nowrap"><span style="display:inline-block;min-width:54px;text-align:center;background:' + (r.hors ? '#ef6c00' : '#2e7d32') + ';color:#fff;border-radius:10px;padding:4px 10px;font-size:22px;font-weight:900">' + (r.hors && !r.colis ? '?' : rgFmt_(r.colis, 1)) + '</span></td></tr>';
  }).join('');
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;color:#1b1b1b">'
    + '<div style="background:#1a4d2e;color:#fff;border-radius:14px;padding:16px 20px">'
    + '<div style="font-size:24px;font-weight:900">🥬 Commande KBG — prépa du ' + rgEsc_(rgLong_(day)) + '</div>'
    + '<div style="font-size:16px;margin-top:2px">Distribution du <b>' + rgEsc_(rgLong_(distrib)) + '</b> · ventes à 5h + 15 %, en colis</div></div>'
    + (warn ? '<div style="margin-top:10px;background:#fdecea;border:2px solid #c62828;border-radius:12px;padding:10px 14px;font-size:14px;font-weight:700;color:#c62828">⚠️ ' + rgEsc_(warn) + '</div>' : '')
    + rgHorsHtml_(rows)
    + '<table role="presentation" width="100%" style="border-collapse:collapse;margin-top:10px"><tr>' + box('Produits', rows.length, '#1565c0') + box('Colis à commander', rgFmt_(tot, 1), '#2e7d32') + '</tr></table>'
    + '<table role="presentation" width="100%" style="border-collapse:collapse;margin-top:10px;border:1px solid #d7e3d7;border-radius:10px">'
    + '<tr style="background:#e8f5e9"><th style="padding:8px 10px;text-align:left;font-size:12px">CODE PROBON</th><th style="padding:8px 10px;text-align:left;font-size:12px">PRODUCTEUR</th><th style="padding:8px 10px;text-align:left;font-size:12px">DÉSIGNATION</th><th style="padding:8px 12px;text-align:right;font-size:12px">COLIS</th></tr>'
    + lines + '</table>'
    + rgAjoutsHtml_(ajouts)
    + '<p style="font-size:15px;margin-top:14px">📎 Fichier complet en pièce jointe (colisage, prix d\'achat, total HT, ventes, stock).<br>'
    + (url ? '<a href="' + url + '" style="color:#1565c0;font-weight:700">Ouvrir la commande dans Google Sheets</a>' : '') + '</p>'
    + '<p style="color:#999;font-size:12px;margin-top:16px">Envoi automatique Kelbongoo · 5h · source : COMMANDE FL KBG x PROBON (colonne COMMANDE PROBON (colis), produits actifs)</p></div>';
}
function rgAjoutsHtml_(ajouts) {
  if (!ajouts || !ajouts.length) return '<div style="margin-top:14px;padding:10px 14px;border:2px dashed #ffb74d;border-radius:12px;color:#7a4100;font-size:14px">➕ Pas d\'ajout Rungis avec cette commande (pas de prépa la veille ou rien à rajouter).</div>';
  var tot = ajouts.reduce(function (a, r) { return a + (r.colis || 0); }, 0);
  return '<div style="margin-top:16px;background:#e65100;color:#fff;border-radius:12px 12px 0 0;padding:10px 14px;font-size:19px;font-weight:900">➕ Ajouts Rungis · ' + rgFmt_(tot, 1) + ' colis'
    + '<div style="font-size:13px;font-weight:600">Demandés hier soir après la prépa, à livrer avec cette commande (rappel)</div></div>'
    + '<table role="presentation" width="100%" style="border-collapse:collapse;border:2px solid #e65100">'
    + ajouts.map(function (r) {
      return '<tr><td style="padding:9px 10px;border-bottom:1px solid #f3d3b8;font-size:18px;font-weight:900;color:#a64b00;white-space:nowrap">' + rgEsc_(r.code || '—') + '</td>'
        + '<td style="padding:9px 10px;border-bottom:1px solid #f3d3b8;font-size:13px;color:#555">' + rgEsc_(r.producteur) + '</td>'
        + '<td style="padding:9px 10px;border-bottom:1px solid #f3d3b8;font-size:16px;font-weight:700">' + rgEsc_(r.designation) + '</td>'
        + '<td style="padding:9px 12px;border-bottom:1px solid #f3d3b8;text-align:right"><span style="display:inline-block;min-width:48px;text-align:center;background:#e65100;color:#fff;border-radius:10px;padding:3px 10px;font-size:20px;font-weight:900">' + rgFmt_(r.colis, 1) + '</span></td></tr>';
    }).join('') + '</table>';
}
function rgMailText_(day, distrib, rows, url, warn, ajouts) {
  var out = ['Commande KBG — prépa du ' + rgLong_(day), 'Distribution du ' + rgLong_(distrib), ''];
  if (warn) out.push('ATTENTION : ' + warn, '');
  if (rows.some(function (r) { return r.hors; })) out.push('ATTENTION : produit(s) vendu(s) mais pas dans le Sheet COMMANDE FL (marqués ⚠️) — demander à Raimbaud de mettre à jour.', '');
  out.push('CODE PROBON | PRODUCTEUR | DÉSIGNATION | COLIS');
  rows.forEach(function (r) { out.push((r.code || '—') + ' | ' + r.producteur + ' | ' + r.designation + ' | ' + rgFmt_(r.colis, 1)); });
  if (ajouts && ajouts.length) { out.push('', 'AJOUTS RUNGIS (demandés hier soir, à livrer avec cette commande) :'); ajouts.forEach(function (r) { out.push((r.code || '—') + ' | ' + r.producteur + ' | ' + r.designation + ' | ' + rgFmt_(r.colis, 1)); }); }
  out.push('', 'Fichier complet en pièce jointe.' + (url ? ' Google Sheets : ' + url : ''));
  return out.join('\n');
}

/** Déclencheur 5h (installé par rungisInstall). force=true : envoi même hors jours prévus. testTo : envoi d'essai. */
function kbRungisCmd5h(force, testTo, dayOverride) {
  var day = dayOverride || rgIso_(new Date());
  var isTest = !!testTo;
  try {
    if (force !== true && RG_DAYS.indexOf(rgDow_(day)) < 0) return { ok: true, skipped: 'jour sans commande' };
    var distrib = rgAddDays_(day, 1);
    var fl = rgReadFL_();
    var rows = rgBuildOrder_(fl);
    var hors = rgHors_(distrib, rows);              // v1.3 : vendus mais absents / Non actifs dans COMMANDE FL
    rows = rows.concat(hors);
    var ajouts = rgAjouts_(day, fl);
    var warn = '';
    // v1.2 : la note de la colonne D est « Rempli automatiquement le 20/10 04:31 — … » (sans l'année)
    var stamp = 'le ' + Utilities.formatDate(new Date(), RG_TZ, 'dd/MM') + ' ';
    if (fl.note5h.indexOf(stamp) < 0) warn = 'La colonne COMMANDE A 5H n\'a pas été remplie automatiquement ce matin (ventes peut-être pas à jour) — vérifier avec Kelbongoo.';
    var to = isTest ? testTo : RG_TO;
    var subject = (isTest ? '[ESSAI] ' : '') + '🥬 Commande KBG ' + rgFr_(day) + ' · ' + rows.length + ' produit(s)' + (ajouts.length ? ' + ' + ajouts.length + ' ajout(s) Rungis' : '');
    if (!rows.length && !ajouts.length) {
      MailApp.sendEmail({ to: to, subject: (isTest ? '[ESSAI] ' : '') + '🥬 Commande KBG ' + rgFr_(day) + ' · rien à commander',
        htmlBody: '<div style="font-family:Arial;font-size:16px"><b>Aucun colis F&L à commander ce matin</b> (prépa du ' + rgEsc_(rgLong_(day)) + ', distribution du ' + rgEsc_(rgLong_(distrib)) + ').' + (warn ? '<br><br><b style="color:#c62828">⚠️ ' + rgEsc_(warn) + '</b>' : '') + '</div>',
        body: 'Aucun colis F&L à commander ce matin.' + (warn ? '\n' + warn : '') });
      if (!isTest) rgSnapSave_(day, distrib, [], '', warn);
      return { ok: true, rows: 0 };
    }
    var ss = rgCreateSheet_(day, distrib, rows, warn, ajouts);
    var url = ss.getUrl();
    var blob = rgXlsxBlob_(ss, 'Commande KBG ' + rgFr_(day).replace(/\//g, '-'));
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: rgMailHtml_(day, distrib, rows, url, warn, ajouts), body: rgMailText_(day, distrib, rows, url, warn, ajouts), attachments: [blob], name: 'Kelbongoo' });
    if (!isTest) rgSnapSave_(day, distrib, rows, url, warn);
    return { ok: true, rows: rows.length, url: url };
  } catch (e) {
    try { MailApp.sendEmail(RG_FAIL_TO, '⚠️ Commande KBG 5h NON envoyée (' + rgFr_(day) + ')', 'Erreur : ' + (e && e.message ? e.message : e) + '\n\nLancer kbRungisCmd5h(true) depuis le projet FL_Probon_Proxy après correction.'); } catch (e2) {}
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function rgSnapSheet_() {
  var ss = SpreadsheetApp.openById(RG_SHEET_ID);
  var sh = ss.getSheetByName(RG_SNAP_TAB);
  if (!sh) { sh = ss.insertSheet(RG_SNAP_TAB); sh.getRange(1, 1, 1, 8).setValues([['DATE', 'DISTRIBUTION', 'ENVOYÉ LE', 'PRODUITS', 'COLIS', 'FICHIER', 'CONTRÔLE', 'DONNÉES']]).setFontWeight('bold'); sh.setFrozenRows(1); }
  return sh;
}
function rgSnapSave_(day, distrib, rows, url, warn) {
  var sh = rgSnapSheet_();
  var slim = rows.map(function (r) { return [r.code, r.producteur, r.designation, r.colis, r.col, r.uv, r.type, r.pa, r.totalHt, r.cmd5h, r.estim, r.stockMu, r.stockCag, r.besoinUv, r.id]; });
  var json = JSON.stringify(slim); if (json.length > 49000) json = JSON.stringify(slim.map(function (x) { return x.slice(0, 9); }));
  var tot = rows.reduce(function (a, r) { return a + r.colis; }, 0);
  sh.appendRow([day, distrib, Utilities.formatDate(new Date(), RG_TZ, 'dd/MM/yyyy HH:mm'), rows.length, Math.round(tot * 10) / 10, url, warn || 'OK', json]);
}

// ───────────────────────── Actions appli (via kbgRungis) ─────────────────────────
function kbRungisRoute_(p) {
  try {
    if (p.action === 'rungis_cmd_get') return rgJson_(rgCmdGet_(String(p.day || '')));
    if (p.action === 'rungis_alert') return rgJson_(rgAlert_(p.alert || {}, String(p._by || p.by || '')));
    if (p.action === 'rungis_driver_check') return rgJson_(rgDriverCheck_(String(p.code || '')));
    return rgJson_({ ok: false, error: 'action inconnue' });
  } catch (e) { return rgJson_({ ok: false, error: String(e && e.message ? e.message : e) }); }
}

var RG_COLS = ['code', 'producteur', 'designation', 'colis', 'col', 'uv', 'type', 'pa', 'totalHt', 'cmd5h', 'estim', 'stockMu', 'stockCag', 'besoinUv', 'id'];
function rgCmdGet_(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = rgIso_(new Date());
  var sh = rgSnapSheet_();
  var v = sh.getDataRange().getValues();
  var snap = null;
  for (var i = v.length - 1; i >= 1; i--) {
    var d = v[i][0] instanceof Date ? rgIso_(v[i][0]) : String(v[i][0]);
    if (d === day) { snap = v[i]; break; }
  }
  var fl = rgReadFL_();
  var cmd;
  if (snap) {
    var arr = []; try { arr = JSON.parse(String(snap[7] || '[]')); } catch (e) {}
    cmd = { day: day, distrib: snap[1] instanceof Date ? rgIso_(snap[1]) : String(snap[1]), sentAt: String(snap[2]), fileUrl: String(snap[5] || ''), warn: String(snap[6] || '') === 'OK' ? '' : String(snap[6] || ''), live: false,
      rows: arr.map(function (x) { var o = {}; RG_COLS.forEach(function (k, j) { o[k] = x[j] == null ? '' : x[j]; }); return o; }) };
  } else cmd = null; // pas de commande envoyée ce jour-là
  // Commande en cours : état actuel du fichier COMMANDE FL (ce qui partirait maintenant)
  var liveRows = rgBuildOrder_(fl);
  liveRows = liveRows.concat(rgHors_(rgAddDays_(rgIso_(new Date()), 1), liveRows));
  var live = { day: rgIso_(new Date()), distrib: rgAddDays_(rgIso_(new Date()), 1), at: Utilities.formatDate(new Date(), RG_TZ, 'dd/MM/yyyy HH:mm'),
    rows: liveRows.map(function (r) { var o = {}; RG_COLS.forEach(function (k) { o[k] = r[k]; }); return o; }) };
  return { ok: true, today: rgIso_(new Date()), cmd: cmd, live: live, rajouts: rgAjouts_(day, fl) };
}

/**
 * Ajouts Rungis livrés avec la commande du jour « day » : demandés la veille au soir, après la clôture de la prépa,
 * pour compléter les commandes clients qui n'ont pas eu leurs produits. Dans DEMANDES RAJOUT FL, « Date distrib »
 * = date de la distribution préparée la veille = jour de cette commande (ex. demandés mardi soir → livrés mercredi).
 * Le dernier envoi d'un même produit fait foi (renvoi = remplacement).
 */
function rgAjouts_(day, fl) {
  var idx = {}, idxDes = {};
  fl.rows.forEach(function (r) { idx[rgNorm_(r.producteur) + '|' + rgNorm_(r.designation)] = r; if (!idxDes[rgNorm_(r.designation)]) idxDes[rgNorm_(r.designation)] = r; });
  var rs = SpreadsheetApp.openById(RG_SHEET_ID).getSheetByName(RG_RAJ_TAB);
  if (!rs) return [];
  var rv = rs.getDataRange().getValues(); var h = {}; (rv[0] || []).forEach(function (x, j) { h[rgNorm_(x)] = j; });
  var ci = function (n) { var k = rgNorm_(n); return h[k] == null ? -1 : h[k]; };
  var cAt = ci('Horodatage'), cDist = ci('Date distrib'), cBy = ci('Par'), cProd = ci('Producteur'), cDes = ci('Produit'), cMq = ci('Manque (UV)'), cCol = ci('Colis demandés');
  var veille = rgAddDays_(day, -1), byKey = {}, lastAt = '';
  for (var k = 1; k < rv.length; k++) {
    var at = cAt >= 0 ? rv[k][cAt] : ''; var atIso = at instanceof Date ? Utilities.formatDate(at, RG_TZ, 'yyyy-MM-dd HH:mm') : String(at || '');
    var dist = cDist >= 0 ? (rv[k][cDist] instanceof Date ? rgIso_(rv[k][cDist]) : String(rv[k][cDist] || '').slice(0, 10)) : '';
    if (!(dist === day || (!dist && atIso.slice(0, 10) === veille))) continue;
    if (atIso > lastAt) lastAt = atIso;
    var prod = String(rv[k][cProd] || ''), des = String(rv[k][cDes] || '');
    var m = idx[rgNorm_(prod) + '|' + rgNorm_(des)] || idxDes[rgNorm_(des)] || null;
    var colis = rgNum_(rv[k][cCol]);
    byKey[atIso + '|' + rgNorm_(prod) + '|' + rgNorm_(des) + '|' + k] = { at: atIso, distrib: dist, by: String(rv[k][cBy] || ''),
      producteur: prod, designation: des, manque: rgNum_(rv[k][cMq]), colis: colis,
      code: m ? m.code : '', col: m ? m.col : '', pa: m ? m.pa : '', uv: m ? m.uv : '', totalHt: m ? Math.round(colis * (m.col || 0) * (m.pa || 0) * 100) / 100 : '' };
  }
  // Garde le dernier envoi (renvoyer remplace l'envoi précédent)
  var all = Object.keys(byKey).map(function (k) { return byKey[k]; });
  var lastBatch = lastAt.slice(0, 16);
  var out = all.filter(function (x) { return x.at.slice(0, 16) === lastBatch; });
  return (out.length ? out : all).sort(function (a, b) { return a.producteur.localeCompare(b.producteur, 'fr') || a.designation.localeCompare(b.designation, 'fr'); });
}

/** Chauffeur Rungis : le code existe, est actif, et la case « Retour PDP » (colonne N) est cochée. */
function rgDriverCheck_(code) {
  code = String(code || '').trim();
  if (!/^\d{4,8}$/.test(code)) return { ok: true, pdp: false };
  var sh = SpreadsheetApp.openById(RG_REGISTRE_ID).getSheets()[0];
  var named = SpreadsheetApp.openById(RG_REGISTRE_ID).getSheetByName('Salariés'); if (named) sh = named;
  var v = sh.getDataRange().getValues(); if (v.length < 2) return { ok: true, pdp: false };
  var h = {}; v[0].forEach(function (x, j) { h[rgNorm_(x)] = j; });
  var cCode = h['CODE'], cPdp = h['RETOUR PDP'], cAct = h['ACTIF'], cPre = h['PRENOM'], cNom = h['NOM'];
  if (cCode == null) return { ok: false, error: 'colonne Code introuvable' };
  if (cPdp == null) cPdp = 13; // colonne N
  var yes = function (x) { if (x === true) return true; var t = rgNorm_(x); return t === 'TRUE' || t === 'VRAI' || t === 'OUI' || t === 'X' || t === '1'; };
  for (var i = 1; i < v.length; i++) {
    if (String(v[i][cCode]).trim() !== code) continue;
    var actif = cAct == null || rgNorm_(v[i][cAct]) !== 'NON';
    var name = [cPre != null ? v[i][cPre] : '', cNom != null ? v[i][cNom] : ''].join(' ').trim();
    return { ok: true, pdp: actif && yes(v[i][cPdp]), name: name };
  }
  return { ok: true, pdp: false };
}

var RG_MOTIFS = { place: 'Pas de place dans le camion', introuvable: 'Palette introuvable', pas_prete: 'Palette pas prête', autre: 'Autre' };
function rgAlert_(a, by) {
  var cut = function (s, n) { return String(s == null ? '' : s).slice(0, n); };
  var site = cut(a.site, 10), label = cut(a.label, 200), note = cut(a.note, 600), motif = RG_MOTIFS[a.motif] || cut(a.motif, 60) || 'Non précisé';
  var siteLabel = cut(a.siteLabel, 60), day = cut(a.day, 10), kind = a.kind === 'roll' ? 'Rolls Kelbongoo' : 'Palette';
  var subject = '⚠️ ' + kind + ' non récupéré' + (a.kind === 'roll' ? 's' : 'e') + ' — ' + site + (siteLabel ? ' ' + siteLabel : '') + ' · ' + label;
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#1b1b1b">'
    + '<div style="background:#c62828;color:#fff;border-radius:14px;padding:16px 20px"><div style="font-size:24px;font-weight:900">⚠️ ' + rgEsc_(kind) + ' NON récupéré' + (a.kind === 'roll' ? 's' : 'e') + '</div>'
    + '<div style="font-size:15px;margin-top:2px">Signalé par le chauffeur <b>' + rgEsc_(by || '—') + '</b> · ' + Utilities.formatDate(new Date(), RG_TZ, 'dd/MM/yyyy HH:mm') + '</div></div>'
    + '<table role="presentation" width="100%" style="border-collapse:collapse;margin-top:12px;font-size:17px">'
    + '<tr><td style="padding:8px 10px;color:#666;width:150px">Boutique</td><td style="padding:8px 10px;font-size:26px;font-weight:900">' + rgEsc_(site) + ' <span style="font-size:15px;color:#555">' + rgEsc_(siteLabel) + '</span></td></tr>'
    + '<tr><td style="padding:8px 10px;color:#666">Quoi</td><td style="padding:8px 10px;font-weight:800">' + rgEsc_(label) + '</td></tr>'
    + (day ? '<tr><td style="padding:8px 10px;color:#666">Prévu le</td><td style="padding:8px 10px">' + rgEsc_(rgFr_(day)) + '</td></tr>' : '')
    + '<tr><td style="padding:8px 10px;color:#666">Motif</td><td style="padding:8px 10px;font-weight:900;color:#c62828">' + rgEsc_(motif) + '</td></tr>'
    + (note ? '<tr><td style="padding:8px 10px;color:#666;vertical-align:top">Note</td><td style="padding:8px 10px;background:#fff8e1;border-radius:8px">« ' + rgEsc_(note) + ' »</td></tr>' : '')
    + '</table><p style="font-size:15px;margin-top:14px">👉 La boutique ne recevra pas cette marchandise au prochain passage : prévoir une solution (autre tournée, prévenir la boutique).</p>'
    + '<p style="color:#999;font-size:12px">Appli Kelbongoo · espace chauffeur Rungis</p></div>';
  MailApp.sendEmail({ to: RG_ALERT_TO, subject: subject, htmlBody: html, body: subject + '\nMotif : ' + motif + (note ? '\nNote : ' + note : '') + '\nSignalé par ' + by, name: 'Kelbongoo' });
  var ss = SpreadsheetApp.openById(RG_SHEET_ID);
  var sh = ss.getSheetByName(RG_ALERT_TAB);
  if (!sh) { sh = ss.insertSheet(RG_ALERT_TAB); sh.appendRow(['DATE', 'PAR', 'TYPE', 'BOUTIQUE', 'QUOI', 'PRÉVU LE', 'MOTIF', 'NOTE']); sh.getRange(1, 1, 1, 8).setFontWeight('bold'); sh.setFrozenRows(1); }
  sh.appendRow([Utilities.formatDate(new Date(), RG_TZ, 'dd/MM/yyyy HH:mm'), by, kind, site, label, day, motif, note]);
  return { ok: true };
}

// ───────────────────────── installation / essai ─────────────────────────
/** Installe le déclencheur quotidien 5h (heure de Paris). Relançable sans doublon. */
function rungisInstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'kbRungisCmd5hTrigger') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('kbRungisCmd5hTrigger').timeBased().atHour(5).nearMinute(0).everyDays(1).inTimezone(RG_TZ).create();
  Logger.log('✅ Déclencheur 5h installé (kbRungisCmd5hTrigger)');
}
function kbRungisCmd5hTrigger() { kbRungisCmd5h(false); }
/** Mail d'essai à hg@probon.fr uniquement (aucune photo enregistrée). */
function rungisTest() { Logger.log(JSON.stringify(kbRungisCmd5h(true, RG_FAIL_TO))); }
/** Renvoi manuel de la commande du jour à gestion@ (ex. après correction). */
function rungisRenvoyer() { Logger.log(JSON.stringify(kbRungisCmd5h(true))); }

/** v1.2 — ESSAI COMPLET « comme demain à 5h », lançable n'importe quel jour (même un lundi) :
 *  1) cherche la PROCHAINE distribution qui a une vente sur le site (demain, sinon après-demain…),
 *  2) écrit ses ventes dans COMMANDE A 5H (exactement ce que fera le déclencheur de 4h30 la veille de cette distribution),
 *  3) envoie le mail [ESSAI] à hg@probon.fr uniquement, daté du jour de prépa (veille de la distribution).
 *  Rien n'est envoyé à gestion@probon.fr et rien n'est enregistré dans COMMANDES 5H. Résultat dans le journal. */
function testCommande5hMaintenant() {
  var today = rgIso_(new Date()), v = null, distrib = '';
  for (var d = 1; d <= 5; d++) {
    distrib = rgAddDays_(today, d);
    v = flAutoVentes(distrib);
    if (v && !v.none) break;
    Logger.log('Pas de vente le ' + rgFr_(distrib));
    v = null;
  }
  if (!v) { Logger.log('❌ Aucune vente trouvée dans les 5 prochains jours.'); return; }
  Logger.log('✅ COMMANDE A 5H remplie avec « ' + v.titles + ' » (distribution du ' + rgFr_(distrib) + ') : ' + v.written + ' lignes, dont ' + v.zeros + ' à 0'
    + (v.untouched.length ? ' · sans ID ni nom trouvé : ' + v.untouched.map(function (x) { return 'L' + x.row + ' ' + x.des; }).join(', ') : '')
    + (v.soldMissing.length ? ' · vendus mais absents du Sheet : ' + v.soldMissing.map(function (x) { return x.des + ' (' + x.n + ')'; }).join(', ') : ''));
  SpreadsheetApp.flush();
  var prep = rgAddDays_(distrib, -1);
  var r = kbRungisCmd5h(true, RG_FAIL_TO, prep);
  Logger.log('📧 Mail d\'essai (prépa du ' + rgFr_(prep) + ') → ' + RG_FAIL_TO + ' : ' + JSON.stringify(r));
}
