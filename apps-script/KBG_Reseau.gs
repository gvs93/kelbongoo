/**
 * KBG_Reseau.gs — v1.1 (01/11/2026) — RELANCE AUTOMATIQUE DES APPELS RÉSEAU (projet FL_Probon_Proxy)
 * v1.1 : « Adresse non disponible » (message Google en français) n'était pas reconnu comme coupure réseau
 *   → report distrib du 30/10 arrêté net (KBG_AncienDistrib, orders/fetch-detail). Ajout de « non disponible »,
 *   « not available », « temporarily », « Exception: Request failed » sans code HTTP.
 * v1.0 (29/10/2026) — Cause : UrlFetchApp lève parfois « Adres niet beschikbaar » / « Address unavailable » (coupure réseau
 *   côté Google, avant toute réponse du site). Avant : le report s'arrêtait net (prépa du 30/10 à 16:05, prépa du 29/10 à 18:35).
 * Maintenant : kbFetch_ = UrlFetchApp.fetch avec 4 essais (pause 1 s, 3 s, 8 s) sur erreur réseau seulement
 *   (une vraie réponse HTTP, même 4xx/5xx, n'est jamais relancée ici).
 *   kbFetchAll_ = UrlFetchApp.fetchAll ; si le paquet entier échoue, chaque appel est refait seul avec relance,
 *   SAUF les bascules (« toggle » ND sans completed:true) : les refaire pourrait décocher → réponse 599, et le contrôle
 *   des coches de KBG_Ancien (ancNdFix_) recoche ce qui doit l'être.
 * Utilisé par KBG_Ancien, KBG_AncienDistrib, KBG_FL_Auto (KbDdp_ → aussi KBG_MEP).
 */
var KB_NET_WAIT = [1000, 3000, 8000];

function kbNetErr_(e) {
  var m = String(e && e.message || e);
  return /niet beschikbaar|unavailable|indisponible|non disponible|not available|temporarily|timed? ?out|Timeout|DNS|socket|connection|connexion|reset|Bandwidth|Service invoked too many|réseau|network/i.test(m);
}

function kbFetch_(url, opt) {
  var last;
  for (var i = 0; i <= KB_NET_WAIT.length; i++) {
    try { return UrlFetchApp.fetch(url, opt || {}); }
    catch (e) {
      last = e;
      if (!kbNetErr_(e) || i === KB_NET_WAIT.length) throw e;
      Utilities.sleep(KB_NET_WAIT[i]);
    }
  }
  throw last;
}

function kbUnsafeRetry_(req) {
  var u = String(req && req.url || '');
  if (u.indexOf('toggle-golpps-completed') < 0) return false;
  try { var p = JSON.parse(decodeURIComponent((u.split('params=')[1] || '').split('&')[0])); return p.completed !== true; } catch (e) { return true; }
}

function kbFakeResp_(msg) {
  var body = JSON.stringify({ message: 'réseau : ' + msg });
  return { getResponseCode: function () { return 599; }, getContentText: function () { return body; }, getAllHeaders: function () { return {}; } };
}

function kbFetchAll_(reqs) {
  if (!reqs || !reqs.length) return [];
  try { return UrlFetchApp.fetchAll(reqs); }
  catch (e) {
    if (!kbNetErr_(e)) throw e;
    Utilities.sleep(1500);
    return reqs.map(function (q) {
      if (kbUnsafeRetry_(q)) return kbFakeResp_(String(e.message || e) + ' (bascule non relancée)');
      try { return kbFetch_(q.url, q); } catch (e2) { return kbFakeResp_(String(e2.message || e2)); }
    });
  }
}
