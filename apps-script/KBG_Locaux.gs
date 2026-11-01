/**
 * KBG_Locaux.gs — v1.0 (01/11/2026) — STATUTS DES LIEUX SUR L'ANCIEN SYSTÈME (locaux.kelbongoo.com)
 * À ajouter dans le projet Apps Script « FL_Probon_Proxy » (réutilise KBA / KbDdp_ de KBG_FL_Auto, KBG_AncienDistrib, KBG_Reseau).
 * ---------------------------------------------------------------------------------------------------------
 * Avant (à la main dans locaux.kelbongoo.com, lieu par lieu) : Terminer la préparation → Lancer la distribution →
 *   (après la distrib, tous les clients passés) Terminer la distribution.
 * Relevé le 01/11/2026 dans le code de locaux.kelbongoo.com (Meteor, méthodes appelées en DDP, compte anouar) :
 *   • globalorders.closeLocalePreparation  { globalorder_id, locale }   préparation (2) → pré-distribution (3)
 *   • globalorders.launchLocaleDistribution { globalorder_id, locale }  pré-distribution (3) → distribution (4)
 *   • globalorders.closeLocaleDistribution  { globalorder_id, locale }  distribution (4) → fini (5)
 *   • globalorders.fetchLocaleDetail { globalorder_id, locale } → { globalorder (locales), globalorderlocale (status) }
 *   • globalorders.fetchGlobalOrderLocales { locale } (tri distribution_date) → globales d'un lieu, avec leur date
 *   Statuts : 0 vente · 1 pré-préparation · 2 préparation · 3 pré-distribution · 4 distribution · 5 fini · 6 annulée.
 *   Testé le 01/11 : closeLocaleDistribution BIC du 31/10 → statut 5.
 *
 * Quand :
 *   1. Prépa du jour J (distribution J+1) : à la fin du report KBG_Ancien (ancWork_ → locAfterPrepa_), et en filet
 *      de sécurité par le déclencheur horaire (locAuto) de 18h à 23h → lieux en 2 : Terminer la préparation,
 *      lieux en 3 : Lancer la distribution. Le serveur refuse si la prépa n'est pas finie → signalé dans le mail.
 *   2. Distribution du jour J : un lieu est terminé quand le report KBG_AncienDistrib du lieu est fait SANS erreur
 *      (DIS_DONE_<jour>_<lieu>, tous les clients passés à la roue) ou si le lieu n'a aucune commande de l'ancien site
 *      dans l'appli. DOM (jamais clôturé dans l'appli) : à 23h, roue pour tous les clients DOM puis terminé.
 *      Lieu non clôturé dans l'appli : la clôture auto de 23h (KBG_AncienDistrib) le reporte, puis il est terminé ici.
 * Simulation : propriété du script LOC_LIVE = false (sinon réel). Mail récap à hg@probon.fr à chaque changement.
 * Lancement manuel : changer LOC_MANUEL puis exécuter locManuelPrepa / locManuelDistrib / locManuelEtat.
 */
var LOC = {
  HOST: 'https://locaux.kelbongoo.com',
  MAIL_TO: 'hg@probon.fr',
  ST: { 0: 'vente', 1: 'pré-préparation', 2: 'préparation', 3: 'pré-distribution', 4: 'distribution', 5: 'fini', 6: 'annulée' },
  PROBE: ['BIC', 'TOL', 'BOR', 'STB', 'PDP', 'ROB', 'DOM', 'PDC', 'BAR']
};
var LOC_MANUEL = { day: '2026-10-31' };   // date de DISTRIBUTION (AAAA-MM-JJ)

function locLive_() { return String(PropertiesService.getScriptProperties().getProperty('LOC_LIVE') || 'true').toLowerCase() !== 'false'; }

/* ═════════════════════════════ CONNEXION (DDP, comme KbDdp_ mais sur locaux.kelbongoo.com) ═════════════════════════════ */
function LocDdp_() {
  KbDdp_.call(this);
  this.base = LOC.HOST + '/sockjs/' + (100 + Math.floor(Math.random() * 899)) + '/' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}
LocDdp_.prototype = Object.create(KbDdp_.prototype);
LocDdp_.prototype._post = function (path, body) {
  var ck = Object.keys(this.cookies).map(function (k) { return k + '=' + this.cookies[k]; }, this).join('; ');
  var opt = { method: 'post', muteHttpExceptions: true, contentType: 'text/plain;charset=UTF-8', payload: body || '',
              headers: { 'Origin': LOC.HOST, 'Referer': LOC.HOST + '/', 'User-Agent': 'Mozilla/5.0 (KBG-Locaux)' } };
  if (ck) opt.headers.Cookie = ck;
  var resp = kbFetch_(this.base + path, opt);
  var h = resp.getAllHeaders()['Set-Cookie'];
  [].concat(h || []).forEach(function (c) { var p = String(c).split(';')[0]; var i = p.indexOf('='); if (i > 0) this.cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }, this);
  var code = resp.getResponseCode();
  if (code >= 400) throw new Error('locaux.kelbongoo.com HTTP ' + code);
  return resp.getContentText();
};
function locConnect_() { var d = new LocDdp_(); d.connect(); d.login(); return d; }
/** Méthode « globalorders.xxx » avec (params, options) comme le site. */
function locCall_(ddp, method, params, options) { return ddp.call(method, [params || {}, options || {}]); }

/* ═════════════════════════════ LECTURE ═════════════════════════════ */
function locParisDay_(iso) { return iso ? Utilities.formatDate(new Date(iso), 'Europe/Paris', 'yyyy-MM-dd') : ''; }
/** _id de la globale dont la distribution est le jour « day ». Cache en propriété. */
function locGlobale_(ddp, day) {
  var P = PropertiesService.getScriptProperties(), k = 'LOC_GO_' + day, c = P.getProperty(k); if (c) return c;
  for (var i = 0; i < LOC.PROBE.length; i++) {
    var r = locCall_(ddp, 'globalorders.fetchGlobalOrderLocales', { locale: LOC.PROBE[i] }, { page: 1, limit: 20, sort: { distribution_date: -1 }, fields: { globalorder_id: 1, distribution_date: 1, distributions: 1 } });
    var hit = (r && r.items || []).filter(function (x) { return locParisDay_(x.distribution_date || (x.distributions && x.distributions[0] && x.distributions[0].start)) === day; })[0];
    if (hit) { P.setProperty(k, hit.globalorder_id); return hit.globalorder_id; }
  }
  throw new Error('globale du ' + day + ' introuvable sur locaux.kelbongoo.com');
}
/** { G, lieux:[{locale, name, status}] } */
function locEtat_(ddp, day) {
  var G = locGlobale_(ddp, day), first = null, out = [];
  for (var i = 0; i < LOC.PROBE.length && !first; i++) { try { first = locCall_(ddp, 'globalorders.fetchLocaleDetail', { globalorder_id: G, locale: LOC.PROBE[i] }); } catch (e) {} }
  if (!first || !first.globalorder) throw new Error('détail de la globale ' + G + ' illisible');
  var codes = (first.globalorder.locales || []).map(function (l) { return String(l.locale || l.code || l).toUpperCase(); }).filter(Boolean);
  // un appel à la fois : le serveur répond « Réseau occupé » si on les envoie en paquet
  codes.forEach(function (l) {
    var g = null, err = '';
    for (var k = 0; k < 3 && !g; k++) { try { g = locCall_(ddp, 'globalorders.fetchLocaleDetail', { globalorder_id: G, locale: l }).globalorderlocale; } catch (e) { err = String(e.message || e); Utilities.sleep(1500); } }
    out.push({ locale: l, name: g ? g.name : '', status: g ? Number(g.status) : null, err: g ? '' : err });
  });
  return { G: G, lieux: out };
}

/* ═════════════════════════════ ACTIONS ═════════════════════════════ */
function locDo_(ddp, G, l, method, lines, dry) {
  if (dry) { lines.push(l.locale + ' : ' + method.split('.')[1] + ' (simulation)'); return true; }
  try { var r = locCall_(ddp, method, { globalorder_id: G, locale: l.locale }); var s = r && r.updatedDoc ? Number(r.updatedDoc.status) : null; l.status = s; lines.push(l.locale + ' → ' + (LOC.ST[s] || s)); return true; }
  catch (e) { lines.push('⚠️ ' + l.locale + ' : ' + method.split('.')[1] + ' refusé — ' + (e.message || e)); return false; }
}
/** Prépa finie (veille de la distribution « day ») : Terminer la préparation puis Lancer la distribution, pour chaque lieu. */
function locPrepa_(day, why) {
  var ddp = locConnect_(), E = locEtat_(ddp, day), dry = !locLive_(), lines = [];
  E.lieux.forEach(function (l) {
    if (l.status === 2) { if (!locDo_(ddp, E.G, l, 'globalorders.closeLocalePreparation', lines, dry)) return; if (dry) l.status = 3; }
    if (l.status === 3) locDo_(ddp, E.G, l, 'globalorders.launchLocaleDistribution', lines, dry);
  });
  locMail_('Prépa → distribution', day, E, lines, why, dry);
  return lines;
}
/** Distribution « day » : Terminer la distribution des lieux prêts (report ancien site fait sans erreur, ou aucune commande ancien site). */
function locDistrib_(day, why, all) {
  var ddp = locConnect_(), E = locEtat_(ddp, day), dry = !locLive_(), lines = [], P = PropertiesService.getScriptProperties();
  var od = null; try { od = fsDoc_('day_' + day + '_orders', 'data'); } catch (e) {}
  var orders = (od && od.orders) || [], oldBySite = {};
  orders.forEach(function (o) { if (!o._test && DIS_OLD_ID.test(String(o.orderId || ''))) oldBySite[String(o.site || '').toUpperCase()] = 1; });
  E.lieux.forEach(function (l) {
    if (l.status !== 4) return;
    var done = !!P.getProperty('DIS_DONE_' + day + '_' + l.locale);
    if (!done && oldBySite[l.locale] && !all) { lines.push(l.locale + ' : en attente du report ancien site (clients pas encore tous passés)'); return; }
    locDo_(ddp, E.G, l, 'globalorders.closeLocaleDistribution', lines, dry);
  });
  if (lines.length) locMail_('Fin de distribution', day, E, lines, why, dry);
  return lines;
}
function locMail_(titre, day, E, lines, why, dry) {
  if (!lines.length) return;
  var rows = E.lieux.map(function (l) { return '<tr><td style="padding:4px 10px;font-weight:800">' + l.locale + '</td><td style="padding:4px 10px">' + rgEsc_(l.name || '') + '</td><td style="padding:4px 10px">' + (LOC.ST[l.status] || l.err || '?') + '</td></tr>'; }).join('');
  var bad = lines.some(function (x) { return x.indexOf('⚠️') === 0; });
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px">'
    + '<div style="background:' + (bad ? '#c62828' : '#2e7d32') + ';color:#fff;border-radius:14px;padding:14px 18px;font-size:21px;font-weight:900">' + (bad ? '⚠️ ' : '✅ ') + titre + ' — ' + rgEsc_(rgLong_(day)) + (dry ? ' (SIMULATION)' : '') + '</div>'
    + '<ul style="font-size:14px">' + lines.map(function (x) { return '<li>' + rgEsc_(x) + '</li>'; }).join('') + '</ul>'
    + '<table style="border-collapse:collapse;font-size:13px">' + rows + '</table>'
    + '<p style="color:#999;font-size:12px">KBG_Locaux v1.0 · locaux.kelbongoo.com · ' + rgEsc_(why || '') + '</p></div>';
  MailApp.sendEmail({ to: LOC.MAIL_TO, subject: (bad ? '⚠️' : '✅') + ' Locaux ' + rgFr_(day) + ' : ' + titre + (dry ? ' (simulation)' : ''), htmlBody: html, name: 'Kelbongoo' });
}

/* ═════════════════════════════ BRANCHEMENTS ═════════════════════════════ */
/** Appelé à la fin du report de prépa (KBG_Ancien) : job.day = date de distribution. */
function locAfterPrepa_(job) {
  try { if (job && job.day && !job.dry && job.state === 'terminé') locPrepa_(job.day, 'fin du report prépa'); }
  catch (e) { MailApp.sendEmail({ to: LOC.MAIL_TO, subject: '⚠️ Locaux ' + (job && job.day) + ' : clôture prépa impossible', body: String(e && e.stack || e), name: 'Kelbongoo' }); }
}
/** Déclencheur horaire (locInstaller). */
function locAuto() {
  var now = disParisNow_(), h = Number(now[1]), today = now[0];
  try {
    if (h >= 18 && h <= 23) locPrepa_(disAddDays_(today, 1), 'contrôle horaire ' + h + 'h');          // prépa du jour = distribution de demain
    if (h >= 12 && h <= 23) {
      if (h >= 23) ancienDistribJour(today, true, 'DOM');                                                // DOM : roue pour tous, puis terminé
      locDistrib_(today, 'contrôle horaire ' + h + 'h', false);
    }
    if (h === 7) locDistrib_(disAddDays_(today, -1), 'rattrapage du lendemain 7h', false);
  } catch (e) { MailApp.sendEmail({ to: LOC.MAIL_TO, subject: '⚠️ Locaux ' + today + ' ' + h + 'h : erreur', body: String(e && e.stack || e), name: 'Kelbongoo' }); }
}
function locInstaller() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'locAuto') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('locAuto').timeBased().everyHours(1).create();
  console.log('Déclencheur locAuto créé · ' + (locLive_() ? 'RÉEL' : 'SIMULATION'));
}
/* ── Manuel : changer LOC_MANUEL.day (date de distribution) puis exécuter ── */
function locManuelEtat() { var d = locConnect_(), E = locEtat_(d, LOC_MANUEL.day); console.log(LOC_MANUEL.day + ' · globale ' + E.G + ' · ' + E.lieux.map(function (l) { return l.locale + '=' + (LOC.ST[l.status] || l.err); }).join(' · ')); }
function locManuelPrepa() { console.log(locPrepa_(LOC_MANUEL.day, 'manuel').join('\n') || 'rien à faire'); }
/** Report ancien site (roue pour tous) de tous les lieux + DOM, puis Terminer la distribution des lieux reportés. */
function locManuelDistrib() {
  var day = LOC_MANUEL.day, E = locEtat_(locConnect_(), day);
  // roue pour tous les clients de chaque lieu encore en distribution (sans attendre la clôture dans l'appli)
  E.lieux.filter(function (l) { return l.status === 4; }).forEach(function (l) { ancienDistribJour(day, true, l.locale); });
  console.log(locDistrib_(day, 'manuel', false).join('\n') || 'rien à faire');
}
