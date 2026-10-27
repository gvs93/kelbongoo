/**
 * KBG_Ancien.gs — v1.1 (27/10/2026) — v1.1 : Réception ND automatique (quantité reçue + coche), journal détaillé produit par produit en direct.
 * v1.0 — REPORT AUTOMATIQUE DE LA PRÉPA SUR L'ANCIEN SITE (preparations.kelbongoo.com)
 * À ajouter dans le projet Apps Script « FL_Probon_Proxy » (même projet que KBG_Rungis.gs / KBG_BL.gs).
 * ---------------------------------------------------------------------------------------------------------
 * Remplace Tampermonkey : plus de navigateur, plus de PC allumé. L'ancien site de prépa n'est qu'une API
 *   GET https://preparations-new.kelbongoo.com/<route>?params=<JSON>&options=<JSON>
 *   en-tête  Authorization: token <jeton Firebase du compte de prépa>
 * (relevé le 27/10/2026 dans le code de preparations.kelbongoo.com). Actions utilisées, les mêmes que les boutons :
 *   • globalorders/fetch-locale-products-list  → liste des produits + avancement par lieu (posés / commandés / coché)
 *   • globalorders/get-dispatch                → bacs d'un produit dans un lieu : order_id, n° de bac, articles à poser / posés
 *   • globalorderlocaleproducerproducts/dispatch-one    → poser 1 article dans son bac (= toucher le casier)
 *   • globalorderlocaleproducerproducts/undispatch-one  → retirer 1 article posé par erreur
 *   • globalorders/toggle-golpps-completed     → coche « Fini » (horloge → ✓) du produit dans le lieu
 *
 * Déroulé : à la clôture de la prépa, l'appli envoie « rungis_ancien_run » { day, products:[{ id (producerproduct), cat, done,
 *   orders:[{ oid, site, q, miss }] }] } (commandes de l'ANCIEN site seulement). Ici, pour chaque produit et chaque lieu :
 *   posés voulus par commande = q − miss (rupture) ; on pose ce qui manque, on retire ce qui est en trop, puis on coche Fini.
 *   Pivot = ID produit (producerproduct_id) et ID commande (order_id) : jamais de rapprochement par nom.
 *   Produit pas terminé dans l'appli → laissé tel quel (signalé). Relance possible sans risque : tout est recalculé
 *   d'après l'état réel de l'ancien site (déjà fait = rien à refaire).
 * Long travail → découpé : 4 min 30 par passage, reprise automatique 1 min après (déclencheur « ancienContinue »).
 * Fin → vérification (relecture de l'ancien site) + mail récap à hg@probon.fr.
 *
 * RÉGLAGES (Fichier › Paramètres du projet › Propriétés du script) — à saisir par Henry, jamais dans le code :
 *   ANC_EMAIL / ANC_PASSWORD : compte de connexion de preparations.kelbongoo.com (compte de prépa)
 *   ANC_LIVE = true          : autorise les écritures. Sinon : SIMULATION seulement (calcule et rapporte, n'écrit rien).
 *   ANC_ND   = true          : (option) fait aussi la « Réception non-dispatch » (quantités ND reçues). Par défaut : non.
 */

var ANC_API     = 'https://preparations-new.kelbongoo.com/';
var ANC_FB_KEY  = 'AIzaSyApzz9odc0DMgHTwcwLQ69lP58n1njIWKI';      // clé publique Firebase de preparations.kelbongoo.com (dans la page)
var ANC_USER_ID = '2W8X2SaMhytesy4ne';                             // userId fixe envoyé par le site lui-même
var ANC_TAB     = 'ANCIEN SITE';
var ANC_MAIL_TO = 'hg@probon.fr';
var ANC_SLICE_MS = 270000;                                         // 4 min 30 de travail par passage
var ANC_LANES   = 8;                                               // produits traités en parallèle (1 seul appel à la fois par produit)

/* ═════════════════════════════ ROUTAGE (appelé par kbRungisRoute_) ═════════════════════════════ */
function kbAncRoute_(p) {
  if (p.action === 'rungis_ancien_run') return ancStart_(p);
  if (p.action === 'rungis_ancien_status') return ancStatus_(String(p.day || ''));
  if (p.action === 'rungis_ancien_stop') { ancJobDel_(); ancTriggersDel_(); return { ok: true }; }
  return { ok: false, error: 'action ancien inconnue' };
}

/* ═════════════════════════════ CONNEXION ═════════════════════════════ */
function ancProps_() { return PropertiesService.getScriptProperties(); }
function ancLive_() { return String(ancProps_().getProperty('ANC_LIVE') || '').toLowerCase() === 'true'; }
function ancToken_() {
  var c = CacheService.getScriptCache(), t = c.get('ANC_TOKEN'); if (t) return t;
  var P = ancProps_(), email = P.getProperty('ANC_EMAIL'), pass = P.getProperty('ANC_PASSWORD');
  if (!email || !pass) throw new Error('Compte ancien site non configuré (propriétés ANC_EMAIL / ANC_PASSWORD)');
  var r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + ANC_FB_KEY, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ email: email, password: pass, returnSecureToken: true }) });
  var j = {}; try { j = JSON.parse(r.getContentText()); } catch (e) {}
  if (r.getResponseCode() !== 200 || !j.idToken) throw new Error('Connexion ancien site refusée : ' + ((j.error && j.error.message) || r.getResponseCode()));
  c.put('ANC_TOKEN', j.idToken, 3000);   // jeton valable 1 h, gardé 50 min
  return j.idToken;
}
function ancReq_(route, params, options) {
  return { url: ANC_API + route + '?params=' + encodeURIComponent(JSON.stringify(params || {})) + '&options=' + encodeURIComponent(JSON.stringify(options || {})),
    headers: { Authorization: 'token ' + ancToken_() }, muteHttpExceptions: true };
}
function ancParse_(r) {
  var code = r.getResponseCode(), txt = r.getContentText(), j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (code === 401 || code === 403) { CacheService.getScriptCache().remove('ANC_TOKEN'); }
  if (code !== 200) throw new Error('HTTP ' + code + ' ' + String((j && (j.message || j.error)) || txt).slice(0, 160));
  return j;
}
function ancGet_(route, params, options) { var q = ancReq_(route, params, options); return ancParse_(UrlFetchApp.fetch(q.url, q)); }
/** Plusieurs appels en parallèle ; renvoie [{ok, j, err}]. */
function ancAll_(reqs) {
  if (!reqs.length) return [];
  var rs = UrlFetchApp.fetchAll(reqs);
  return rs.map(function (r) { try { return { ok: true, j: ancParse_(r) }; } catch (e) { return { ok: false, err: String(e.message || e) }; } });
}

/* ═════════════════════════════ DONNÉES ANCIEN SITE ═════════════════════════════ */
/** globalorder (distribution) du jour : trouvé par la liste des produits, en essayant les globalorders récents de l'admin. */
function ancGlobalOrder_(day) {
  var cache = ancProps_().getProperty('ANC_GO_' + day); if (cache) return cache;
  var ddp = new KbDdp_(); ddp.connect(); ddp.login();
  var g = flAutoGlobalOrders_(ddp).filter(function (x) { return x.day === day; })[0];
  if (!g) throw new Error('Distribution du ' + day + ' introuvable sur l\'ancien site');
  ancProps_().setProperty('ANC_GO_' + day, g._id);
  return g._id;
}
/** Tous les produits de la distribution (frais = couloir 0, sec = couloir 1) : { ppId: {name, couloir, prog:{locale:{ord, done, completed}}} } */
/** v1.1 — Réception non-dispatch (ND) : par lieu, produits sans dispatch → { ppId: { locale: {ord, rec, completed} } } */
function ancProductsND_(G, locales) {
  var out = {};
  locales.forEach(function (loc) {
    var items = [];
    for (var page = 1; page <= 10; page++) {
      var j = ancGet_('globalorders/fetch-locale-products-list', { globalorder_id: G, locale: loc, dispatch_done: { $exists: false }, filterUnsold: true, getGroupedDispatchProducts: false },
        { page: page, limit: 500, sort: { product_name: 1 } });
      var got = j.items || []; items = items.concat(got);
      if (!got.length || items.length >= (Number(j.count) || 0)) break;
    }
    items.forEach(function (x) { (out[x.producerproduct_id] = out[x.producerproduct_id] || {})[loc] = { ord: Number(x.locale_quantity_ordered) || 0, rec: Number(x.locale_quantity_received) || 0, completed: !!x.locale_completed, name: x.product_name }; });
  });
  return out;
}
function ancLocales_(job) { var m = { BIC: 1, BOR: 1, PDP: 1, STB: 1, TOL: 1 }; (job.todo || []).forEach(function (x) { (x.orders || []).forEach(function (o) { if (o.site && o.site !== 'DOM') m[o.site] = 1; }); }); return Object.keys(m); }
function ancProducts_(G) {
  var out = {};
  [0, 1].forEach(function (cl) {
    var items = [];
    for (var page = 1; page <= 20; page++) {
      var j = ancGet_('globalorders/fetch-locale-products-list', { globalorder_id: G, locale: 'BIC', user_id: ANC_USER_ID, couloir: cl, dispatch_done: { $exists: true }, getGroupedDispatchProducts: true },
        { page: page, limit: 500, sort: { product_name: 1 } });
      var got = j.items || []; items = items.concat(got);
      if (!got.length || items.length >= (Number(j.count) || 0)) break;
    }
    items.forEach(function (x) {
      var prog = {}; (x.locale_progress || []).forEach(function (l) { prog[l.locale] = { ord: Number(l.quantity_ordered) || 0, done: Number(l.dispatch_done) || 0, completed: !!l.completed }; });
      out[x.producerproduct_id] = { name: x.product_name, producer: x.producer_name, couloir: cl, prog: prog };
    });
  });
  return out;
}

/* ═════════════════════════════ PLAN D'UN PRODUIT (fonction pure, testée hors Apps Script) ═════════════════════════════
 * want : { orderId: articles à poser } ; dispatch : réponse get-dispatch d'UN lieu ([{order_id, number, items:[ids à poser], done:[ids posés]}])
 * → { calls:[{route, params}], lines:[…détail…], unknown:[order_id présents sur l'ancien site mais pas dans l'appli] } */
function ancPlanLocale_(G, ppId, locale, want, dispatch) {
  var calls = [], lines = [], unknown = [];
  (dispatch || []).forEach(function (e) {
    var oid = String(e.order_id || ''), items = e.items || [], done = e.done || [], total = items.length + done.length;
    var w = Object.prototype.hasOwnProperty.call(want, oid) ? Math.max(0, Math.min(total, want[oid])) : null;
    if (w == null) { unknown.push(oid); return; }                     // commande inconnue de l'appli : on n'y touche pas
    var ln = { bac: e.number, locale: e.locale || locale, oid: oid, total: total, deja: done.length, voulu: w, pose: 0, retire: 0 };
    if (done.length < w) items.slice(0, w - done.length).forEach(function (id) { calls.push({ route: 'globalorderlocaleproducerproducts/dispatch-one', params: { dispatch_id: id, globalorder_id: G, locale: e.locale || locale, producerproduct_id: ppId, userId: ANC_USER_ID } }); ln.pose++; });
    if (done.length > w) done.slice(0, done.length - w).forEach(function (id) { calls.push({ route: 'globalorderlocaleproducerproducts/undispatch-one', params: { dispatch_id: id, globalorder_id: G, locale: e.locale || locale, producerproduct_id: ppId, userId: ANC_USER_ID } }); ln.retire++; });
    lines.push(ln);
  });
  return { calls: calls, lines: lines, unknown: unknown };
}

/* ═════════════════════════════ TRAVAIL (file + reprise) ═════════════════════════════ */
function ancJobFile_() {
  var f = rgFolder_(), it = f.getFilesByName('ancien_site_job.json');
  return it.hasNext() ? it.next() : null;
}
function ancJobGet_() { var f = ancJobFile_(); if (!f) return null; try { return JSON.parse(f.getBlob().getDataAsString()); } catch (e) { return null; } }
function ancJobPut_(job) { var f = ancJobFile_(), s = JSON.stringify(job); if (f) f.setContent(s); else rgFolder_().createFile('ancien_site_job.json', s, 'application/json'); }
function ancJobDel_() { var f = ancJobFile_(); if (f) f.setTrashed(true); }
function ancTriggersDel_() { ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'ancienContinue') ScriptApp.deleteTrigger(t); }); }

/** p : { day, products, by, dry } — appelé par l'appli à la clôture de la prépa (ou bouton Master). */
function ancStart_(p) {
  var day = String(p.day || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: 'jour invalide' };
  var prods = Array.isArray(p.products) ? p.products : []; if (!prods.length) return { ok: false, error: 'aucun produit' };
  var lock = LockService.getScriptLock(); if (!lock.tryLock(20000)) return { ok: false, error: 'un report est déjà en cours' };
  try {
    var dry = p.dry === true || p.dry === 'true' || !ancLive_();
    var job = { v: 1, day: day, by: String(p.by || '').slice(0, 60), dry: dry, startedAt: new Date().toISOString(), state: 'en cours',
      todo: prods.map(function (x) { return { id: String(x.id), produit: String(x.produit || '').slice(0, 120), cat: String(x.cat || ''), done: !!x.done,
        orders: (x.orders || []).map(function (o) { return { oid: String(o.oid), site: String(o.site || '').toUpperCase(), q: Number(o.q) || 0, miss: Number(o.miss) || 0 }; }) }; }),
      i: 0, res: { faits: 0, deja: 0, attente: [], absents: [], erreurs: [], inconnus: [], nd: [], ndFaits: 0, poses: 0, retires: 0, coches: 0, appels: 0, detail: [] } };
    ancJobPut_(job); ancTriggersDel_();
    ancWork_(job);
    return { ok: true, result: ancPublic_(ancJobGet_() || job) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { lock.releaseLock(); }
}
/** Déclencheur de reprise (nom sans « _ » : appelable par un déclencheur). */
function ancienContinue() {
  ancTriggersDel_();
  var lock = LockService.getScriptLock(); if (!lock.tryLock(5000)) { ScriptApp.newTrigger('ancienContinue').timeBased().after(60000).create(); return; }
  try { var job = ancJobGet_(); if (job && job.state === 'en cours') ancWork_(job); } finally { lock.releaseLock(); }
}
function ancWork_(job) {
  var t0 = Date.now(), R = job.res;
  try {
    var G = job.G || (job.G = ancGlobalOrder_(job.day));
    var A = ancProducts_(G), N = ancProductsND_(G, ancLocales_(job));
    if (!Object.keys(A).length) throw new Error('Aucun produit lu sur l\'ancien site pour la distribution du ' + job.day + ' (globalorder ' + G + ')');
    while (job.i < job.todo.length && Date.now() - t0 < ANC_SLICE_MS) {
      var lane = job.todo.slice(job.i, job.i + ANC_LANES);
      ancDoLane_(G, A, N, lane, job);
      job.i += lane.length;
      ancJobPut_(job);
    }
    if (job.i < job.todo.length) { ScriptApp.newTrigger('ancienContinue').timeBased().after(60000).create(); return; }
    // Fin : vérification sur l'état relu de l'ancien site
    job.verif = ancVerify_(G, job);
    job.state = 'terminé'; job.endedAt = new Date().toISOString();
    ancJobPut_(job); ancLog_(job); ancMail_(job);
  } catch (e) {
    job.state = 'erreur'; job.error = String(e.message || e); job.endedAt = new Date().toISOString();
    ancJobPut_(job); ancLog_(job); ancMail_(job);
  }
}
/** Un paquet de produits : get-dispatch (parallèle), puis écritures en parallèle sur des produits DIFFÉRENTS (jamais 2 à la fois pour un même produit).
 *  v1.1 : les lieux où le produit est en ND passent par la Réception ND (quantité reçue = commandé − rupture, puis coche). */
function ancDoLane_(G, A, N, lane, job) {
  var R = job.res, work = [], queues = {}, D = R.detail || (R.detail = []);
  var log = function (q, txt) { (q.d = q.d || []).push(txt); };
  var Q = function (x) { return queues[x.id] || (queues[x.id] = { x: x, calls: [], locs: [], d: [] }); };
  lane.forEach(function (x) {
    var a = A[x.id], nd = N[x.id];
    if (!x.done) { R.attente.push(x.produit); D.push({ p: x.produit, s: 'attente', d: 'pas terminé dans l\'appli — non reporté', at: Date.now() }); return; }
    if (!a && !nd) { R.absents.push(x.produit); D.push({ p: x.produit, s: 'absent', d: 'introuvable sur l\'ancien site', at: Date.now() }); return; }
    var bySite = {}, wantSite = {};
    x.orders.forEach(function (o) { var w = Math.max(0, o.q - o.miss); (bySite[o.site] = bySite[o.site] || {})[o.oid] = ((bySite[o.site] || {})[o.oid] || 0) + w; wantSite[o.site] = (wantSite[o.site] || 0) + w; });
    if (a) Object.keys(a.prog).forEach(function (loc) {
      var pr = a.prog[loc]; if (!pr.ord) return;
      work.push({ x: x, a: a, loc: loc, want: bySite[loc] || {}, pr: pr });
    });
    if (nd) Object.keys(nd).forEach(function (loc) {
      var n = nd[loc]; if (!n.ord) return;
      var q = Q(x), w = Math.min(n.ord, wantSite[loc] || 0), did = [];
      if (n.rec !== w) { q.calls.push({ route: 'globalorders/update-nondispatch-quantity-received', params: { globalorder_id: G, locale: loc, producerproduct_id: x.id, quantity: w } }); did.push('reçu ' + w + '/' + n.ord); }
      if (!n.completed) { q.calls.push({ route: 'globalorders/toggle-golpps-completed', params: { globalorder_id: G, locale: loc, producerproduct_id: x.id, userId: ANC_USER_ID, excludedLocales: [], isND: true }, nd: true }); did.push('✓'); }
      if (did.length) { q.fresh = true; q.ndDone = (q.ndDone || 0) + 1; log(q, 'ND ' + loc + ' ' + did.join(' ')); } else log(q, 'ND ' + loc + ' déjà ok');
    });
  });
  if (work.length) {
    var gets = ancAll_(work.map(function (w) { return ancReq_('globalorders/get-dispatch', { globalorder_id: G, locale: w.loc, producerproduct_id: w.x.id, user_id: ANC_USER_ID, couloir: w.a.couloir ? 'sec' : 'frais', getGroupedDispatchProducts: false }); }));
    R.appels += gets.length;
    work.forEach(function (w, k) {
      var g = gets[k], q = Q(w.x); if (!g.ok) { q.err = (q.err || 0) + 1; R.erreurs.push(w.x.produit + ' (' + w.loc + ') : lecture ' + g.err); log(q, w.loc + ' ⚠️ lecture impossible'); return; }
      var pl = ancPlanLocale_(G, w.x.id, w.loc, w.want, (g.j && g.j.dispatch) || []);
      if (pl.unknown.length) R.inconnus.push(w.x.produit + ' (' + w.loc + ') : ' + pl.unknown.length + ' commande(s) de l\'ancien site absente(s) de l\'appli — laissée(s) telle(s) quelle(s)');
      pl.calls.forEach(function (c) { q.calls.push(c); });
      var po = 0, re = 0; pl.lines.forEach(function (l) { R.poses += l.pose; R.retires += l.retire; po += l.pose; re += l.retire; });
      var tick = !pl.unknown.length && (!w.pr.completed || pl.calls.length > 0);
      if (pl.unknown.length) q.noTick = true;
      else if (tick) q.locs.push(w.loc);
      if (!w.pr.completed || pl.calls.length > 0) q.fresh = true;
      log(q, w.loc + ' : ' + (po || re ? (po ? '+' + po + ' posé' + (po > 1 ? 's' : '') : '') + (re ? ' −' + re + ' retiré' + (re > 1 ? 's' : '') : '') : (w.pr.completed ? 'déjà à jour' : '0 à poser')) + (tick ? ' · ✓ Fini' : '') + (pl.unknown.length ? ' · ⚠️ ' + pl.unknown.length + ' commande(s) inconnue(s), pas de coche' : ''));
    });
  }
  var ids = Object.keys(queues);
  if (!job.dry) {
    // Écritures : tour par tour, 1 appel par produit et par tour (parallèle entre produits)
    var more = true;
    while (more) {
      more = false; var batch = [], who = [];
      ids.forEach(function (id) { var q = queues[id]; if (q.calls.length) { var c = q.calls.shift(); batch.push(ancReq_(c.route, c.params)); who.push({ q: q, c: c }); more = more || q.calls.length > 0; } });
      if (!batch.length) break;
      var rs = ancAll_(batch); R.appels += rs.length;
      rs.forEach(function (r, k) { var q = who[k].q; if (!r.ok) { q.err = (q.err || 0) + 1; if (q.err <= 2) R.erreurs.push(q.x.produit + ' : ' + r.err); } else if (who[k].c.nd) R.coches++; });
    }
    // Coche « Fini » par lieu (dispatch) — seulement si aucune erreur sur le produit
    var ticks = [], tw = [];
    ids.forEach(function (id) { var q = queues[id]; if (q.err) return; q.locs.forEach(function (loc) { ticks.push(ancReq_('globalorders/toggle-golpps-completed', { globalorder_id: G, locale: loc, producerproduct_id: id, userId: ANC_USER_ID, completed: true, excludedLocales: [], isND: false })); tw.push(q); }); });
    var tr = ancAll_(ticks); R.appels += tr.length;
    tr.forEach(function (r, k) { if (r.ok) R.coches++; else { tw[k].err = (tw[k].err || 0) + 1; R.erreurs.push(tw[k].x.produit + ' : coche Fini ' + r.err); } });
  } else ids.forEach(function (id) { var q = queues[id]; R.coches += q.locs.length + q.calls.filter(function (c) { return c.nd; }).length; });
  ids.forEach(function (id) {
    var q = queues[id];
    if (q.err) { D.push({ p: q.x.produit, s: 'err', d: q.d.join(' · ') + ' · ⚠️ erreur', at: Date.now() }); return; }
    if (q.fresh) { R.faits++; if (q.ndDone) R.ndFaits++; } else R.deja++;
    D.push({ p: q.x.produit, s: q.fresh ? (job.dry ? 'afaire' : 'ok') : 'deja', d: q.d.join(' · '), at: Date.now() });
  });
  if (D.length > 700) R.detail = D.slice(-700);
}
/** Relit l'ancien site : chaque produit terminé dans l'appli doit être coché partout, avec le bon nombre d'articles posés. */
function ancVerify_(G, job) {
  var A = ancProducts_(G), N = ancProductsND_(G, ancLocales_(job)), bad = [];
  job.todo.forEach(function (x) {
    var a = A[x.id], nd = N[x.id]; if (!x.done || (!a && !nd)) return;
    var want = {}; x.orders.forEach(function (o) { want[o.site] = (want[o.site] || 0) + Math.max(0, o.q - o.miss); });
    if (nd) Object.keys(nd).forEach(function (loc) { var n = nd[loc]; if (!n.ord) return; var w = Math.min(n.ord, want[loc] || 0); if (!n.completed || n.rec !== w) bad.push(x.produit + ' · ND ' + loc + ' : reçu ' + n.rec + ' / ' + w + ' attendu(s)' + (n.completed ? '' : ' · pas coché')); });
    if (a) Object.keys(a.prog).forEach(function (loc) {
      var pr = a.prog[loc]; if (!pr.ord) return;
      var w = want[loc] || 0;
      if (!pr.completed || pr.done !== w) bad.push(x.produit + ' · ' + loc + ' : ' + pr.done + ' posé(s) / ' + w + ' attendu(s)' + (pr.completed ? '' : ' · pas coché'));
    });
  });
  return { ok: !bad.length, bad: bad.slice(0, 80), nBad: bad.length, at: new Date().toISOString() };
}

/* ═════════════════════════════ ÉTAT / JOURNAL / MAIL ═════════════════════════════ */
function ancPublic_(job) {
  if (!job) return null;
  var R = job.res || {};
  return { day: job.day, dry: !!job.dry, state: job.state, by: job.by, startedAt: job.startedAt, endedAt: job.endedAt || '', error: job.error || '',
    n: (job.todo || []).length, i: job.i || 0, faits: R.faits || 0, deja: R.deja || 0, poses: R.poses || 0, retires: R.retires || 0, coches: R.coches || 0, appels: R.appels || 0,
    attente: (R.attente || []).slice(0, 50), absents: (R.absents || []).slice(0, 50), nd: (R.nd || []).slice(0, 50), ndFaits: R.ndFaits || 0, erreurs: (R.erreurs || []).slice(0, 50), inconnus: (R.inconnus || []).slice(0, 30),
    detail: (R.detail || []).slice(-700),
    verif: job.verif || null, live: ancLive_() };
}
function ancStatus_(day) {
  var job = ancJobGet_();
  if (job && (!day || job.day === day)) return { ok: true, result: ancPublic_(job) };
  var sh = blSs_().getSheetByName(ANC_TAB); if (!sh) return { ok: true, result: null };
  var v = sh.getDataRange().getValues();
  for (var i = v.length - 1; i >= 1; i--) if (!day || String(v[i][0]).slice(0, 10) === day || (v[i][0] instanceof Date && rgIso_(v[i][0]) === day)) { try { return { ok: true, result: JSON.parse(String(v[i][6] || 'null')) }; } catch (e) {} }
  return { ok: true, result: null };
}
function ancLog_(job) {
  var ss = blSs_(), sh = ss.getSheetByName(ANC_TAB);
  if (!sh) { sh = ss.insertSheet(ANC_TAB); sh.getRange(1, 1, 1, 7).setValues([['DISTRIBUTION', 'LANCÉ', 'FINI', 'MODE', 'RÉSULTAT', 'DÉTAIL', 'DONNÉES']]).setFontWeight('bold').setBackground('#1a4d2e').setFontColor('#fff'); sh.setFrozenRows(1); }
  var P = ancPublic_(job), js = JSON.stringify(P);
  if (js.length > 49000) { var P2 = JSON.parse(js); P2.detail = (P2.detail || []).filter(function (d) { return d.s !== 'deja'; }).slice(-250); js = JSON.stringify(P2); if (js.length > 49000) { delete P2.detail; js = JSON.stringify(P2); } }
  sh.appendRow([job.day, job.startedAt, job.endedAt || '', job.dry ? 'SIMULATION' : 'RÉEL', job.state === 'erreur' ? '⚠️ ERREUR' : (P.verif && P.verif.ok ? '✅ OK' : '⚠️ À VÉRIFIER'),
    P.faits + ' produit(s) · ' + P.poses + ' posé(s) · ' + P.retires + ' retiré(s) · ' + P.coches + ' coche(s) · ' + P.ndFaits + ' ND' + (P.erreurs.length ? ' · ' + P.erreurs.length + ' erreur(s)' : ''), js]);
}
function ancMail_(job) {
  var P = ancPublic_(job), ok = job.state !== 'erreur' && P.verif && P.verif.ok && !P.erreurs.length;
  var li = function (t, a, c) { return a && a.length ? '<div style="margin-top:12px"><div style="font-size:15px;font-weight:800;color:' + c + '">' + t + ' (' + a.length + ')</div><ul style="margin:4px 0;padding-left:18px;font-size:13px">' + a.map(function (x) { return '<li>' + rgEsc_(x) + '</li>'; }).join('') + '</ul></div>' : ''; };
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;color:#1b1b1b">'
    + '<div style="background:' + (ok ? '#2e7d32' : '#c62828') + ';color:#fff;border-radius:14px;padding:16px 20px"><div style="font-size:23px;font-weight:900">' + (ok ? '✅' : '⚠️') + ' Ancien site — prépa du ' + rgEsc_(rgLong_(job.day)) + (job.dry ? ' (SIMULATION)' : '') + '</div>'
    + '<div style="font-size:16px;margin-top:4px">' + (job.state === 'erreur' ? 'Arrêté : ' + rgEsc_(job.error) : P.faits + ' produit(s) reporté(s) · ' + P.deja + ' déjà à jour') + '</div></div>'
    + '<p style="font-size:15px;margin:12px 2px"><b>' + P.poses + '</b> article(s) posé(s) · <b>' + P.retires + '</b> retiré(s) · <b>' + P.coches + '</b> coche(s) « Fini » · <b>' + P.ndFaits + '</b> ND reçu(s)' + (job.dry ? ' — <b>à faire</b> (rien n\'a été écrit)' : '') + '</p>'
    + (P.verif ? '<p style="font-size:15px;margin:4px 2px">' + (P.verif.ok ? '🔎 Vérification : l\'ancien site correspond à la prépa de l\'appli.' : '🔎 Vérification : <b>' + P.verif.nBad + ' écart(s)</b> avec la prépa de l\'appli') + '</p>' : '')
    + li('🔎 Écarts après report', P.verif && P.verif.bad, '#c62828') + li('⚠️ Erreurs', P.erreurs, '#c62828')
    + li('⏳ Pas terminés dans l\'appli (non reportés)', P.attente, '#b45309') + li('❔ Introuvables sur l\'ancien site', P.absents, '#616161')
    + li('ℹ️ Commandes de l\'ancien site inconnues de l\'appli', P.inconnus, '#616161')
    + '<p style="color:#999;font-size:12px;margin-top:16px">Report automatique KBG_Ancien v1.1 · ' + (job.dry ? 'simulation (ANC_LIVE ≠ true)' : 'réel') + ' · ' + rgEsc_(job.by || '') + ' · ' + P.appels + ' appel(s)</p></div>';
  MailApp.sendEmail({ to: ANC_MAIL_TO, subject: (ok ? '✅' : '⚠️') + ' Ancien site ' + rgFr_(job.day) + (job.dry ? ' (simulation)' : '') + ' : ' + P.faits + ' produit(s) reporté(s)' + (P.verif && !P.verif.ok ? ' · ' + P.verif.nBad + ' écart(s)' : ''), htmlBody: html, name: 'Kelbongoo' });
}

/* ═════════════════════════════ ESSAIS ÉDITEUR ═════════════════════════════ */
/** Vérifie la connexion et la distribution du jour suivant (lecture seule). */
function ancienTestConnexion() {
  var d = new Date(); d.setDate(d.getDate() + 1); var day = rgIso_(d);
  var G = ancGlobalOrder_(day), A = ancProducts_(G), L = Object.keys(A).map(function (k) { return A[k]; });
  var withOrd = L.filter(function (a) { return Object.keys(a.prog).some(function (l) { return a.prog[l].ord > 0; }); });
  Logger.log('Distribution ' + day + ' · globalorder ' + G + ' · ' + L.length + ' produits (' + withOrd.length + ' commandés) · écriture ' + (ancLive_() ? 'ACTIVÉE' : 'désactivée (simulation)'));
}
