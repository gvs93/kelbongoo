/**
 * KBG_BL.gs — v1.0 (22/10/2026) — à ajouter dans le projet Apps Script « FL_Probon_Proxy »
 * ---------------------------------------------------------------------------------------------
 * CONTRÔLE DU BON DE LIVRAISON RUNGIS (BL) contre la commande KBG du jour.
 *
 * Rungis (gestion@probon.fr) envoie chaque matin à achat@probon.fr le BL PDF de ce qu'il livre.
 * Le BL est en KILOS ou en PIÈCES (colonne Qté), pas en colis. On compare :
 *     attendu (kg / pce) = colis commandés × COL (colisage)   — commande envoyée à 4h30 (onglet COMMANDES 5H)
 *                        + colis des rajouts F&L de la veille × COL   (onglet DEMANDES RAJOUT FL, « Date distrib » = jour du BL)
 *     livré   (kg / pce) = Qté du BL
 *   Exemple : 7 vendus à 4h30 → +15 % = 8 → 1 colis de 12 → 12 kg attendus. BL 12,00 → ✅.
 *
 * Le code du BL (A00729…) n'est PAS le code Probon du Sheet (1043…). La correspondance est apprise une fois
 * (onglet « CONCORDANCE BL ») : automatique seulement si elle est sûre (même produit dans PVTTC : nom + prix),
 * sinon la ligne est « à rapprocher » dans l'appli (Espace Rungis › Contrôle BL) — jamais de supposition silencieuse.
 *
 * Entrées :
 *   • action « rungis_bl_check »  (appli Espace Rungis / Master, ou script relais de la boîte achat@probon.fr)
 *       { pdf: <base64>, name, subject, source, by, force }
 *   • action « rungis_bl_list »   → derniers contrôles (appli)
 *   • action « rungis_bl_concord » { blCode, codes:"1043" ou "1,2,3" ou "" (oublier) } puis relance le contrôle
 * Sortie : onglet « CONTRÔLE BL » (1 ligne par BL), PDF rangé dans « Commandes KBG Rungis / BL Rungis »,
 *          et SI INCOHÉRENCE : mail « ⚠️ BL Rungis » à rr@pribon.org + hg@probon.fr.
 *
 * Aucune dépendance externe : le PDF est décompressé (inflate) et lu par ce fichier.
 * Utilise rgReadFL_, rgAjouts_, rgSnapSheet_ (KBG_Rungis.gs) et flAutoReadPvttc_ (KBG_FL_Auto.gs) du même projet.
 */

var BL_ALERT_TO   = 'rr@pribon.org, hg@probon.fr';
var BL_TAB        = 'CONTRÔLE BL';
var BL_CONC_TAB   = 'CONCORDANCE BL';
var BL_FOLDER     = 'BL Rungis';
var BL_TOL        = 0.10;   // tolérance quantité : ±10 % (pesée, arrondis)
var BL_PRIX_TOL   = 0.10;   // écart de prix signalé au-delà de 0,10 €/kg ou €/pce (information, ne déclenche pas le mail seul)

/* ═════════════════════════════ 1) INFLATE (zlib) — port de tiny-inflate (MIT) ═════════════════════════════ */
var BlInflate_ = (function () {
  function Tree() { this.table = new Uint16Array(16); this.trans = new Uint16Array(288); }
  function Data(src) { this.source = src; this.sourceIndex = 0; this.tag = 0; this.bitcount = 0; this.dest = []; this.destLen = 0; this.ltree = new Tree(); this.dtree = new Tree(); }
  var sltree = new Tree(), sdtree = new Tree();
  var lengthBits = new Uint8Array(30), lengthBase = new Uint16Array(30), distBits = new Uint8Array(30), distBase = new Uint16Array(30);
  var clcidx = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  var codeTree = new Tree(), lengths = new Uint8Array(288 + 32), offs = new Uint16Array(16);
  function buildBitsBase(bits, base, delta, first) {
    var i, sum;
    for (i = 0; i < delta; ++i) bits[i] = 0;
    for (i = 0; i < 30 - delta; ++i) bits[i + delta] = i / delta | 0;
    for (sum = first, i = 0; i < 30; ++i) { base[i] = sum; sum += 1 << bits[i]; }
  }
  function buildFixed(lt, dt) {
    var i;
    for (i = 0; i < 7; ++i) lt.table[i] = 0;
    lt.table[7] = 24; lt.table[8] = 152; lt.table[9] = 112;
    for (i = 0; i < 24; ++i) lt.trans[i] = 256 + i;
    for (i = 0; i < 144; ++i) lt.trans[24 + i] = i;
    for (i = 0; i < 8; ++i) lt.trans[24 + 144 + i] = 280 + i;
    for (i = 0; i < 112; ++i) lt.trans[24 + 144 + 8 + i] = 144 + i;
    for (i = 0; i < 5; ++i) dt.table[i] = 0;
    dt.table[5] = 32;
    for (i = 0; i < 32; ++i) dt.trans[i] = i;
  }
  function buildTree(t, lens, off, num) {
    var i, sum;
    for (i = 0; i < 16; ++i) t.table[i] = 0;
    for (i = 0; i < num; ++i) t.table[lens[off + i]]++;
    t.table[0] = 0;
    for (sum = 0, i = 0; i < 16; ++i) { offs[i] = sum; sum += t.table[i]; }
    for (i = 0; i < num; ++i) if (lens[off + i]) t.trans[offs[lens[off + i]]++] = i;
  }
  function getbit(d) {
    if (!d.bitcount--) { d.tag = d.source[d.sourceIndex++] | 0; d.bitcount = 7; }
    var bit = d.tag & 1; d.tag >>>= 1; return bit;
  }
  function readBits(d, num, base) {
    if (!num) return base;
    while (d.bitcount < 24) { d.tag |= (d.source[d.sourceIndex++] | 0) << d.bitcount; d.bitcount += 8; }
    var val = d.tag & (0xffff >>> (16 - num));
    d.tag >>>= num; d.bitcount -= num;
    return val + base;
  }
  function decodeSymbol(d, t) {
    while (d.bitcount < 24) { d.tag |= (d.source[d.sourceIndex++] | 0) << d.bitcount; d.bitcount += 8; }
    var sum = 0, cur = 0, len = 0, tag = d.tag;
    do { cur = 2 * cur + (tag & 1); tag >>>= 1; ++len; sum += t.table[len]; cur -= t.table[len]; } while (cur >= 0);
    d.tag = tag; d.bitcount -= len;
    return t.trans[sum + cur];
  }
  function decodeTrees(d, lt, dt) {
    var hlit = readBits(d, 5, 257), hdist = readBits(d, 5, 1), hclen = readBits(d, 4, 4), i, num, length;
    for (i = 0; i < 19; ++i) lengths[i] = 0;
    for (i = 0; i < hclen; ++i) lengths[clcidx[i]] = readBits(d, 3, 0);
    buildTree(codeTree, lengths, 0, 19);
    for (num = 0; num < hlit + hdist;) {
      var sym = decodeSymbol(d, codeTree);
      if (sym === 16) { var prev = lengths[num - 1]; for (length = readBits(d, 2, 3); length; --length) lengths[num++] = prev; }
      else if (sym === 17) { for (length = readBits(d, 3, 3); length; --length) lengths[num++] = 0; }
      else if (sym === 18) { for (length = readBits(d, 7, 11); length; --length) lengths[num++] = 0; }
      else lengths[num++] = sym;
    }
    buildTree(lt, lengths, 0, hlit);
    buildTree(dt, lengths, hlit, hdist);
  }
  function blockData(d, lt, dt) {
    for (;;) {
      var sym = decodeSymbol(d, lt);
      if (sym === 256) return;
      if (sym < 256) { d.dest[d.destLen++] = sym; continue; }
      sym -= 257;
      var length = readBits(d, lengthBits[sym], lengthBase[sym]);
      var dist = decodeSymbol(d, dt);
      var o = d.destLen - readBits(d, distBits[dist], distBase[dist]);
      if (o < 0) throw new Error('inflate : distance invalide');
      for (var i = o; i < o + length; ++i) d.dest[d.destLen++] = d.dest[i];
    }
  }
  function stored(d) {
    while (d.bitcount > 8) { d.sourceIndex--; d.bitcount -= 8; }
    var length = d.source[d.sourceIndex + 1] * 256 + d.source[d.sourceIndex];
    var inv = d.source[d.sourceIndex + 3] * 256 + d.source[d.sourceIndex + 2];
    if (length !== (~inv & 0xffff)) throw new Error('inflate : bloc brut invalide');
    d.sourceIndex += 4;
    for (var i = length; i; --i) d.dest[d.destLen++] = d.source[d.sourceIndex++];
    d.bitcount = 0;
  }
  buildFixed(sltree, sdtree);
  buildBitsBase(lengthBits, lengthBase, 4, 3);
  buildBitsBase(distBits, distBase, 2, 1);
  lengthBits[28] = 0; lengthBase[28] = 258;
  /** bytes : tableau d'octets 0..255 (flux zlib, en-tête 2 octets). Retourne un tableau d'octets. */
  return function (bytes) {
    var start = ((bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0) ? 2 : 0; // en-tête zlib
    var d = new Data(bytes.slice ? bytes.slice(start) : Array.prototype.slice.call(bytes, start));
    var bfinal;
    do {
      bfinal = getbit(d);
      var btype = readBits(d, 2, 0);
      if (btype === 0) stored(d);
      else if (btype === 1) blockData(d, sltree, sdtree);
      else if (btype === 2) { decodeTrees(d, d.ltree, d.dtree); blockData(d, d.ltree, d.dtree); }
      else throw new Error('inflate : type de bloc invalide');
      if (d.sourceIndex > d.source.length + 4) throw new Error('inflate : fin de flux inattendue');
    } while (!bfinal);
    return d.dest;
  };
})();

/* ═════════════════════════════ 2) TEXTE DU PDF ═════════════════════════════ */
function blBytesToStr_(b, from, to) {
  var out = [], CH = 8192;
  for (var i = from; i < to; i += CH) out.push(String.fromCharCode.apply(null, b.slice(i, Math.min(to, i + CH))));
  return out.join('');
}
/** Décode une chaîne littérale PDF « (…) » (échappements \( \) \\ \n \ddd). */
function blPdfLit_(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, function (m, c) {
    if (c === 'n') return '\n'; if (c === 'r') return '\r'; if (c === 't') return '\t'; if (c === 'b' || c === 'f') return '';
    if (c === '(' || c === ')' || c === '\\') return c;
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return '';
  });
}
/** Extrait les morceaux de texte positionnés {page, x, y, s} d'un PDF (octets 0..255). */
function blPdfItems_(bytes) {
  var raw = blBytesToStr_(bytes, 0, bytes.length);
  var items = [], page = 0, re = /stream\r?\n/g, m;
  while ((m = re.exec(raw))) {
    if (raw.substr(m.index - 3, 3) === 'end') continue;          // « endstream »
    var start = m.index + m[0].length;
    var dictStart = raw.lastIndexOf('<<', m.index), dict = raw.slice(Math.max(0, dictStart), m.index);
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject|\/Length1|\/FontFile/.test(dict)) continue;   // images / polices : on saute
    var lm = dict.match(/\/Length\s+(\d+)(\s+\d+\s+R)?/);
    var end = lm && !lm[2] ? start + Number(lm[1]) : raw.indexOf('endstream', start);
    if (end < 0) continue;
    var content;
    if (/\/FlateDecode/.test(dict)) {
      try { var out = BlInflate_(bytes.slice(start, end)); content = blBytesToStr_(out, 0, out.length); } catch (e) { continue; }
    } else if (!/\/Filter/.test(dict)) content = raw.slice(start, end);
    else continue;
    if (!/BT[\s\S]*?ET/.test(content)) continue;
    page++;
    // Lecture séquentielle des opérateurs texte : BT / Td / TD / Tm / T* / Tj / TJ / ' / "
    var tok = /\((?:\\[\s\S]|[^\\)])*\)|\[(?:\((?:\\[\s\S]|[^\\)])*\)|[^\]])*\]|-?\d*\.?\d+|\/[^\s\/\[\]()<>]+|[A-Za-z'"*]+/g, t, stack = [];
    var x = 0, y = 0, lx = 0, ly = 0, lead = 0;
    var show = function (str) { var s = blPdfLit_(str).replace(/\s+/g, ' ').trim(); if (s) items.push({ page: page, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, s: s }); };
    while ((t = tok.exec(content))) {
      var v = t[0];
      if (v.charAt(0) === '(' || v.charAt(0) === '[' || /^-?\d*\.?\d+$/.test(v) || v.charAt(0) === '/') { stack.push(v); if (stack.length > 12) stack.shift(); continue; }
      var n = function (k) { return Number(stack[stack.length - k]) || 0; };
      switch (v) {
        case 'BT': x = y = lx = ly = 0; break;
        case 'Td': case 'TD': lx += n(2); ly += n(1); x = lx; y = ly; if (v === 'TD') lead = -n(1); break;
        case 'Tm': lx = x = n(2); ly = y = n(1); break;
        case 'TL': lead = n(1); break;
        case 'T*': ly -= lead; x = lx; y = ly; break;
        case 'Tj': case "'": case '"':
          if (v !== 'Tj') { ly -= lead; x = lx; y = ly; }
          var lit = stack.length ? stack[stack.length - 1] : '';
          if (lit.charAt(0) === '(') show(lit.slice(1, -1));
          break;
        case 'TJ':
          var arr = stack.length ? stack[stack.length - 1] : '';
          if (arr.charAt(0) === '[') { var parts = arr.match(/\((?:\\[\s\S]|[^\\)])*\)/g) || []; show(parts.map(function (p) { return p.slice(1, -1); }).join('')); }
          break;
      }
      stack = [];
    }
  }
  return items;
}

/** Lignes du BL : {code, des, prix, qte, total, ligne} + date (yyyy-MM-dd), n° de BL, réf. commande, totaux. */
function blParse_(items) {
  var rows = {};
  items.forEach(function (it) { var k = it.page + '|' + Math.round(it.y); (rows[k] = rows[k] || []).push(it); });
  var keys = Object.keys(rows).sort(function (a, b) { var A = a.split('|'), B = b.split('|'); return (Number(A[0]) - Number(B[0])) || (Number(B[1]) - Number(A[1])); });
  var lines = [], date = '', num = '', ref = '', totalHt = null, isNum = function (s) { return /^-?\d{1,3}([ .]\d{3})*([.,]\d+)?$|^-?\d+([.,]\d+)?$/.test(s); };
  var toN = function (s) { s = String(s).replace(/\s/g, ''); if (/,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); return Number(s); };
  var all = items.map(function (i) { return i.s; });
  all.forEach(function (s, i) {
    var dm = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if (dm && !date) date = dm[3] + '-' + dm[2] + '-' + dm[1];
    var bm = s.match(/\b\d{1,3}-\d{1,3}-BL\d+\b|\bBL\d{6,}\b/); if (bm && !num) num = bm[0];
    var rm = s.match(/^(\d{8})\s+C\d+$/); if (rm && !ref) ref = s;
  });
  keys.forEach(function (k) {
    var r = rows[k].sort(function (a, b) { return a.x - b.x; });
    var line = r.map(function (i) { return i.s; }).join(' ');
    var ht = line.match(/Total net HT\s*:?\s*(\d[\d\s.,]*)/i); if (ht && toN(ht[1]) > 0) totalHt = toN(ht[1]);
    var ci = -1; for (var i = 0; i < r.length; i++) if (/^[A-Z]\d{4,6}$/.test(r[i].s)) { ci = i; break; }
    if (ci < 0) return;
    var des = [], nums = [];
    for (var j = 0; j < r.length; j++) {
      if (j === ci) continue;
      if (isNum(r[j].s) && r[j].x > r[ci].x) nums.push(toN(r[j].s)); else if (r[j].x > r[ci].x) des.push(r[j].s);
    }
    if (!des.length || nums.length < 2) return;
    lines.push({ code: r[ci].s, des: des.join(' '), prix: nums[0], qte: nums[1], total: nums.length > 2 ? nums[2] : 0 });
  });
  if (!date && ref) date = ref.slice(0, 4) + '-' + ref.slice(4, 6) + '-' + ref.slice(6, 8);
  return { date: date, num: num, ref: ref, totalHt: totalHt, lines: lines };
}

/* ═════════════════════════════ 3) RAPPROCHEMENT BL ↔ CODE PROBON ═════════════════════════════ */
var BL_STOP = { BIO: 1, FR: 1, KG: 1, PCE: 1, PC: 1, PIECE: 1, PIECES: 1, DE: 1, DU: 1, LA: 1, LE: 1, LES: 1, DES: 1, ET: 1, EN: 1, A: 1, AU: 1, G: 1, GR: 1, BQ: 1, BARQ: 1, BARQUETTE: 1, SACHET: 1, CAT: 1, CAL: 1, VARIETES: 1, MULTIPLES: 1, ESP: 1, IT: 1, ITA: 1 };
function blTok_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/\b(P|PDT)\b\.?\s*(DE\s+)?TERRE\b/g, 'POMME TERRE').replace(/\bPOMMES\b/g, 'POMME').replace(/\bOIGNONS\b/g, 'OIGNON').replace(/\bPOIRES\b/g, 'POIRE')
    .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ')
    .filter(function (w) { return w && !BL_STOP[w] && !/\d/.test(w) && w.length > 1; });
}
function blTokEq_(a, b) {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  if (a.indexOf(b) === 0 || b.indexOf(a) === 0) return true;                 // CHANTECLER / CHANTECLERC
  if (Math.abs(a.length - b.length) > 1) return false;
  var i = 0, j = 0, diff = 0;                                                  // 1 lettre d'écart au plus
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}
function blSim_(a, b) {
  var A = blTok_(a), B = blTok_(b); if (!A.length || !B.length) return 0;
  var ua = {}, ub = {}; A.forEach(function (w) { ua[w] = 1; }); B.forEach(function (w) { ub[w] = 1; });
  var ka = Object.keys(ua), kb = Object.keys(ub), inter = 0, usedB = {};
  ka.forEach(function (w) { for (var i = 0; i < kb.length; i++) if (!usedB[i] && blTokEq_(w, kb[i])) { usedB[i] = 1; inter++; return; } });
  var dice = 2 * inter / (ka.length + kb.length);
  return (blTokEq_(A[0], B[0]) ? 0.15 : 0) + dice;      // même 1er mot (le produit) = bonus
}
/** Propose un code Probon pour une ligne de BL.
 *  PV  = PVTTC ({list:[{code,des,pa}], byCode}) ; exp = attendus du jour ({code:{des,pa}}) ; taken = codes déjà reliés à une autre ligne du BL.
 *  Sûr (enregistré tout seul) seulement si :
 *   (a) parmi les produits COMMANDÉS ce jour : même produit (1er mot identique, nom ≥ 75 % proche — désignation PVTTC ou KBG)
 *       et aucun autre produit commandé presque aussi proche (écart ≥ 0,15) ;
 *   (b) sinon dans tout PVTTC : nom quasi identique (≥ 95 %), même prix (±0,02 €) et aucun autre candidat proche.
 *  Sinon : « à rapprocher » dans l'appli avec les meilleures suggestions (jamais de supposition silencieuse). */
function blGuess_(line, PV, exp, taken) {
  taken = taken || {}; exp = exp || {};
  var byCode = PV.byCode || {}, cand = {};
  var put = function (code, des, pa, inExp) {
    code = String(code); if (taken[code]) return;
    var s = blSim_(line.des, des), dp = pa ? Math.abs(Number(pa) - (Number(line.prix) || 0)) : 9;
    var c = cand[code] || (cand[code] = { code: code, des: des, sim: 0, dp: 9, exp: false });
    if (s > c.sim) { c.sim = s; c.des = des; }
    if (dp < c.dp) c.dp = dp;
    if (inExp) c.exp = true;
  };
  Object.keys(exp).forEach(function (code) {
    var x = exp[code]; put(code, x.des, x.pa, true);
    if (byCode[code]) put(code, byCode[code].des, byCode[code].pa, true);
  });
  (PV.list || []).forEach(function (x) { put(x.code, x.des, x.pa, !!exp[String(x.code)]); });
  var all = Object.keys(cand).map(function (k) { return cand[k]; }).filter(function (x) { return x.sim >= 0.5; });
  var head = blTok_(line.des)[0] || '';
  var headOk = function (x) { return blTokEq_(blTok_(x.des)[0] || '', head); };
  var ex = all.filter(function (x) { return x.exp; }).sort(function (a, b) { return b.sim - a.sim; });
  var sure = '';
  if (ex.length && ex[0].sim >= 0.75 && headOk(ex[0]) && (!ex[1] || ex[0].sim - ex[1].sim >= 0.15)) sure = ex[0].code;
  if (!sure) {
    var pv = all.slice().sort(function (a, b) { return (b.sim + (b.dp <= 0.02 ? 0.35 : 0)) - (a.sim + (a.dp <= 0.02 ? 0.35 : 0)); });
    if (pv.length && pv[0].sim >= 0.95 && pv[0].dp <= 0.02 && headOk(pv[0]) && (!pv[1] || pv[0].sim - pv[1].sim >= 0.2)) sure = pv[0].code;
  }
  var top = all.sort(function (a, b) { return (b.sim + (b.exp ? 0.3 : 0)) - (a.sim + (a.exp ? 0.3 : 0)); }).slice(0, 6)
    .map(function (x) { return { code: x.code, des: x.des, sim: Math.round(x.sim * 100), exp: x.exp }; });
  return { sure: sure, top: top };
}

/** Rapprochement automatique de toutes les lignes inconnues du BL (3 passes : un code relié libère les suivants).
 *  Ajoute les correspondances sûres dans conc (muté) et retourne {blCode: guess} pour les lignes traitées. */
function blAutoConc_(bl, PV, exp, conc) {
  var guesses = {};
  for (var pass = 0; pass < 3; pass++) {
    var taken = {}; Object.keys(conc).forEach(function (k) { (conc[k] || []).forEach(function (c) { taken[c] = 1; }); });
    var claim = {}, changed = false;
    bl.lines.forEach(function (l) {
      if (conc[l.code] && conc[l.code].length) return;
      var g = blGuess_(l, PV, exp, taken); guesses[l.code] = g;
      if (g.sure) (claim[g.sure] = claim[g.sure] || []).push(l.code);
    });
    Object.keys(claim).forEach(function (code) {
      if (claim[code].length !== 1) { claim[code].forEach(function (bc) { guesses[bc].sure = ''; }); return; } // 2 lignes pour 1 code : on ne tranche pas
      conc[claim[code][0]] = [code]; changed = true;
    });
    if (!changed) break;
  }
  Object.keys(guesses).forEach(function (bc) { if (!(conc[bc] && conc[bc].length)) guesses[bc].sure = ''; else guesses[bc].sure = guesses[bc].sure || conc[bc][0]; });
  return guesses;
}

/* ═════════════════════════════ 4) COMPARAISON ═════════════════════════════ */
/** exp : {code: {code, des, prod, colis, col, qty, pa, cmdColis, rajColis}} — qty = colis × col (kg ou pièces).
 *  conc : {blCode: ["1043", …]}. Retourne { lines:[…], missing:[…], counts, alert } — fonction pure (testée hors Apps Script). */
function blCompare_(bl, exp, conc, guesses) {
  var used = {}, out = [];
  bl.lines.forEach(function (l) {
    var codes = (conc[l.code] || []).filter(Boolean), g = guesses && guesses[l.code];
    var r = { blCode: l.code, des: l.des, prix: l.prix, qte: l.qte, total: l.total, codes: codes, status: '', msg: '', attendu: null, colis: null, col: null, ecart: 0, prixKbg: null, top: g ? g.top : [] };
    if (!codes.length) {
      r.status = 'rapprocher';
      r.msg = 'Produit du BL pas encore relié à un code Probon — à rapprocher (une seule fois)';
      out.push(r); return;
    }
    var e = codes.map(function (c) { return exp[c]; }).filter(Boolean);
    codes.forEach(function (c) { used[c] = 1; });
    if (!e.length) {
      r.status = l.qte > 0 ? 'nonCommande' : 'ok0';
      r.msg = l.qte > 0 ? 'Livré mais PAS dans la commande KBG du jour' : 'Ligne à 0 (non commandé)';
      out.push(r); return;
    }
    var att = 0, colis = 0, colMax = 0, rajColis = 0, unknown = false, hi = 0, pa = 0, des = [];
    e.forEach(function (x) {
      if (x.unknown) unknown = true;
      att += x.qty; colis += x.colis; rajColis += x.rajColis || 0; colMax = Math.max(colMax, x.col || 0);
      hi += Math.max(x.qty, Math.ceil(x.colis - 1e-9) * (x.col || 0)); if (x.pa) pa = x.pa; des.push(x.des);
    });
    r.attendu = Math.round(att * 100) / 100; r.colis = Math.round(colis * 10) / 10; r.col = colMax; r.rajColis = rajColis; r.kbg = des.join(' + ');
    r.prixKbg = pa || null;
    var lo = att * (1 - BL_TOL) - 0.01, up = hi * (1 + BL_TOL) + 0.01;
    if (unknown) { r.status = 'aConfirmer'; r.msg = 'Quantité à confirmer (produit vendu absent du Sheet)'; }
    else if (att > 0 && l.qte <= 0) { r.status = 'manquant'; r.ecart = -att; r.msg = 'NON LIVRÉ (0 sur le BL)'; }
    else if (l.qte < lo) { r.status = 'moins'; r.ecart = Math.round((l.qte - att) * 100) / 100; r.msg = 'Livré en MOINS'; }
    else if (l.qte > up) { r.status = 'plus'; r.ecart = Math.round((l.qte - att) * 100) / 100; r.msg = 'Livré en PLUS'; }
    else { r.status = 'ok'; r.msg = 'Conforme'; }
    if (r.status === 'moins' || r.status === 'manquant') {
      if (rajColis > 0 && Math.abs((att - l.qte) - rajColis * colMax) <= Math.max(0.5, att * BL_TOL)) r.msg += ' — le rajout de la veille (' + blFmt_(rajColis, 1) + ' colis) n\'a pas été livré';
    }
    if (r.prixKbg && Math.abs(r.prix - r.prixKbg) > BL_PRIX_TOL) r.prixEcart = Math.round((r.prix - r.prixKbg) * 100) / 100;
    out.push(r);
  });
  var missing = Object.keys(exp).filter(function (c) { return !used[c] && exp[c].qty > 0 && !exp[c].unknown; }).map(function (c) {
    var x = exp[c]; return { code: c, des: x.des, prod: x.prod, colis: x.colis, col: x.col, attendu: Math.round(x.qty * 100) / 100, rajColis: x.rajColis || 0, status: 'absent', msg: 'Commandé mais ABSENT du BL' };
  });
  // Commandé mais absent : si une ligne du BL « à rapprocher » le propose, c'est probablement elle (pas un écart tant que non confirmé)
  missing.forEach(function (m) {
    var cand = out.filter(function (r) { return r.status === 'rapprocher' && (r.top || []).some(function (t) { return String(t.code) === String(m.code); }); })[0];
    if (cand) { m.status = 'absentProbable'; m.msg = 'Probablement « ' + cand.des + ' » du BL (' + blFmt_(cand.qte) + ') — à confirmer dans l\'appli'; m.blCode = cand.blCode; }
  });
  var res = { lines: out, missing: missing };
  res.counts = blCount_(res);
  return res;
}
function blCount_(res) {
  var cnt = { ok: 0, ok0: 0, moins: 0, plus: 0, manquant: 0, absent: 0, absentProbable: 0, nonCommande: 0, rapprocher: 0, aConfirmer: 0, prix: 0 };
  res.lines.forEach(function (r) { if (cnt[r.status] != null) cnt[r.status]++; if (r.prixEcart) cnt.prix++; });
  res.missing.forEach(function (m) { cnt[m.status] = (cnt[m.status] || 0) + 1; });
  res.nEcarts = cnt.moins + cnt.plus + cnt.manquant + cnt.absent + cnt.nonCommande;
  res.alert = res.nEcarts > 0 || cnt.rapprocher > 0;
  return cnt;
}
function blFmt_(n, dec) { var p = Math.pow(10, dec == null ? 2 : dec); var x = Math.round(Number(n || 0) * p) / p; return String(x).replace('.', ','); }

/* ═════════════════════════════ 5) DONNÉES (Sheet) ═════════════════════════════ */
function blSs_() { return SpreadsheetApp.openById(RG_SHEET_ID); }
function blConcSheet_() {
  var sh = blSs_().getSheetByName(BL_CONC_TAB);
  if (!sh) {
    sh = blSs_().insertSheet(BL_CONC_TAB);
    sh.getRange(1, 1, 1, 7).setValues([['CODE BL', 'DÉSIGNATION BL', 'CODE(S) PROBON', 'DÉSIGNATION KBG / PVTTC', 'SOURCE', 'PAR', 'LE']]).setFontWeight('bold').setBackground('#1565c0').setFontColor('#fff');
    sh.setFrozenRows(1); sh.setColumnWidth(2, 300); sh.setColumnWidth(4, 300);
  }
  return sh;
}
function blConcRead_() {
  var v = blConcSheet_().getDataRange().getValues(), m = {};
  for (var i = 1; i < v.length; i++) {
    var k = String(v[i][0] || '').trim(); if (!k) continue;
    m[k] = String(v[i][2] == null ? '' : v[i][2]).split(/[,;+\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  return m;
}
function blConcWrite_(blCode, blDes, codes, kbgDes, source, by) {
  var sh = blConcSheet_(), v = sh.getDataRange().getValues(), row = -1;
  for (var i = 1; i < v.length; i++) if (String(v[i][0]).trim() === blCode) { row = i + 1; break; }
  var vals = [[blCode, blDes || '', codes.join(','), kbgDes || '', source, by || '', Utilities.formatDate(new Date(), RG_TZ, 'dd/MM/yyyy HH:mm')]];
  if (!codes.length) { if (row > 0) sh.deleteRow(row); return; }
  if (row > 0) sh.getRange(row, 1, 1, 7).setValues(vals); else sh.appendRow(vals[0]);
}

/** Attendu du jour « day » (jour du BL = jour de la commande 4h30) : commande envoyée + rajouts de la veille. */
function blExpected_(day, PV) {
  var snap = null, v = rgSnapSheet_().getDataRange().getValues();
  for (var i = v.length - 1; i >= 1; i--) { var d = v[i][0] instanceof Date ? rgIso_(v[i][0]) : String(v[i][0]).slice(0, 10); if (d === day) { snap = v[i]; break; } }
  var exp = {}, fl = rgReadFL_(), byDes = {};
  fl.rows.forEach(function (r) { if (r.code) byDes[rgNorm_(r.designation)] = r; });
  var add = function (code, des, prod, colis, col, pa, kind, unknown) {
    code = String(code || '').trim(); if (!code) return false;
    var x = exp[code] || (exp[code] = { code: code, des: des, prod: prod, colis: 0, col: Number(col) || 0, qty: 0, pa: Number(pa) || 0, cmdColis: 0, rajColis: 0, unknown: false });
    colis = Number(colis) || 0;
    x.colis += colis; x.qty += colis * (Number(col) || x.col || 0);
    if (kind === 'raj') x.rajColis += colis; else x.cmdColis += colis;
    if (unknown) x.unknown = true;
    if (!x.col && col) x.col = Number(col);
    return true;
  };
  var noCode = [];
  if (snap) {
    var arr = []; try { arr = JSON.parse(String(snap[7] || '[]')); } catch (e) {}
    arr.forEach(function (x) {   // [code, producteur, designation, colis, col, uv, type, pa, totalHt, cmd5h, estim, …]
      var hors = /PAS dans le Sheet/.test(String(x[2] || ''));
      var des = String(x[2] || '').replace(/\s*⚠️.*$/, '');
      if (!add(x[0], des, x[1], x[3], x[4], x[7], 'cmd', hors && !(Number(x[3]) > 0))) noCode.push({ des: des, prod: x[1], colis: x[3], hors: hors });
    });
  }
  var raj = [];
  try { raj = rgAjouts_(day, fl); } catch (e) {}
  raj.forEach(function (r) {
    var code = r.code, col = r.col, pa = r.pa;
    if (!code && PV) { var g = flAutoBestRungis_(r.designation, PV, {}); if (g && g.sure) { code = String(g.sure.code); col = g.sure.col; pa = g.sure.pa; } }
    if (!add(code, r.designation, r.producteur, r.colis, col, pa, 'raj')) noCode.push({ des: r.designation, prod: r.producteur, colis: r.colis, rajout: true });
  });
  var sentAt = snap ? (snap[2] instanceof Date ? Utilities.formatDate(snap[2], RG_TZ, 'dd/MM/yyyy HH:mm') : String(snap[2])) : '';
  return { exp: exp, snapFound: !!snap, sentAt: sentAt, nRaj: raj.length, noCode: noCode };
}

/* ═════════════════════════════ 6) CONTRÔLE COMPLET ═════════════════════════════ */
function blB64ToBytes_(b64) { return Utilities.base64Decode(String(b64 || '')).map(function (x) { return x & 0xff; }); }

/** p : { pdf (base64), name, subject, source, by, force, mailDate } */
function kbBlCheck_(p) {
  if (!p.pdf) return { ok: false, error: 'PDF manquant' };
  var bytes = blB64ToBytes_(p.pdf);
  if (bytes.length < 100 || String.fromCharCode.apply(null, bytes.slice(0, 5)) !== '%PDF-') return { ok: false, error: 'Ce fichier n\'est pas un PDF' };
  var bl = blParse_(blPdfItems_(bytes));
  if (!bl.lines.length) return { ok: false, error: 'Aucune ligne produit lue dans ce PDF (BL Rungis attendu : Code · Désignation · Prix Net · Qté · Total)' };
  if (!bl.date) {   // date du BL absente : sujet du mail « BL PROBON 22/10 », nom du fichier, puis date du mail
    var s = String(p.subject || '') + ' ' + String(p.name || ''), m = s.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    if (m) { var y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : Utilities.formatDate(new Date(), RG_TZ, 'yyyy'); bl.date = y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2); }
    else bl.date = p.mailDate && /^\d{4}-\d{2}-\d{2}/.test(p.mailDate) ? String(p.mailDate).slice(0, 10) : rgIso_(new Date());
  }
  var PV = { list: [], byCode: {} }; try { PV = flAutoReadPvttc_(); } catch (e) {}
  var E = blExpected_(bl.date, PV);
  var conc = blConcRead_(), guesses = blAutoConc_(bl, PV, E.exp, conc);
  Object.keys(guesses).forEach(function (bc) {
    var g = guesses[bc]; if (!g.sure) return;
    var l = bl.lines.filter(function (x) { return x.code === bc; })[0];
    blConcWrite_(bc, l ? l.des : '', [g.sure], (E.exp[g.sure] || {}).des || (PV.byCode[g.sure] || {}).des || '', 'auto (produit commandé / PVTTC)', 'contrôle BL');
  });
  // Produits vendus hors Sheet (sans code) : rapprochés par le nom pour info « quantité à confirmer »
  var res = blCompare_(bl, E.exp, conc, guesses);
  res.lines.forEach(function (r) {
    if (r.status !== 'rapprocher' && r.status !== 'nonCommande') return;
    var h = E.noCode.filter(function (n) { return blSim_(r.des, n.des) >= 0.75 && blTokEq_(blTok_(r.des)[0] || '', blTok_(n.des)[0] || ''); })[0];
    if (h) { r.status = 'aConfirmer'; r.kbg = h.des; r.msg = h.hors ? 'Produit vendu absent du Sheet (commandé « quantité à confirmer ») — à vérifier' : 'Rajout sans code Probon — à vérifier'; }
  });
  res.counts = blCount_(res);
  var data = { day: bl.date, num: bl.num, ref: bl.ref, totalHt: bl.totalHt, nLines: bl.lines.length, snapFound: E.snapFound, sentAt: E.sentAt, nRaj: E.nRaj,
    noCode: E.noCode, lines: res.lines, missing: res.missing, counts: res.counts, nEcarts: res.nEcarts, alert: res.alert,
    at: Utilities.formatDate(new Date(), RG_TZ, 'dd/MM/yyyy HH:mm'), source: String(p.source || 'appli').slice(0, 40), by: String(p.by || p._by || '').slice(0, 60), name: String(p.name || '').slice(0, 120) };
  if (!E.snapFound) { data.alert = true; data.noCmd = true; }
  // PDF rangé dans le Drive
  try {
    var blob = Utilities.newBlob(Utilities.base64Decode(p.pdf), 'application/pdf', 'BL Rungis ' + rgFr_(bl.date).replace(/\//g, '-') + (bl.num ? ' ' + bl.num : '') + '.pdf');
    var f = blFolder_(), old = f.getFilesByName(blob.getName());
    while (old.hasNext()) old.next().setTrashed(true);
    data.fileUrl = f.createFile(blob).getUrl();
  } catch (e) { data.fileErr = String(e.message || e); }
  // Mail seulement si incohérence (et pas déjà envoyé pour le même BL avec le même résultat, sauf force)
  var sig = blSig_(data), prev = blFindPrev_(bl.num || bl.date);
  data.sig = sig;
  // Relance depuis l'appli (après un rapprochement) : pas de nouveau mail, sauf demande explicite (force)
  var forced = p.force === true || p.force === 'true';
  if (data.alert && (forced || (!p.quiet && (!prev || prev.sig !== sig)))) {
    try { blMail_(data); data.mailed = Utilities.formatDate(new Date(), RG_TZ, 'dd/MM HH:mm'); } catch (e) { data.mailErr = String(e.message || e); }
  } else if (prev && prev.mailed) data.mailed = prev.mailed;
  blSave_(data);
  return { ok: true, result: data };
}
function blSig_(d) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify([d.lines.map(function (l) { return [l.blCode, l.status, l.qte]; }), d.missing.map(function (m) { return m.code; })]))).slice(0, 16);
}
function blFolder_() {
  var parent = rgFolder_(), it = parent.getFoldersByName(BL_FOLDER);
  return it.hasNext() ? it.next() : parent.createFolder(BL_FOLDER);
}
function blSheet_() {
  var sh = blSs_().getSheetByName(BL_TAB);
  if (!sh) {
    sh = blSs_().insertSheet(BL_TAB);
    sh.getRange(1, 1, 1, 9).setValues([['DATE BL', 'N° BL', 'CONTRÔLÉ LE', 'SOURCE', 'RÉSULTAT', 'ÉCARTS', 'MAIL', 'PDF', 'DONNÉES']]).setFontWeight('bold').setBackground('#1a4d2e').setFontColor('#fff');
    sh.setFrozenRows(1);
  }
  return sh;
}
function blFindPrev_(key) {
  var v = blSheet_().getDataRange().getValues();
  for (var i = v.length - 1; i >= 1; i--) if (String(v[i][1] || '') === key || (!v[i][1] && String(v[i][0]) === key)) { try { return JSON.parse(String(v[i][8] || '{}')); } catch (e) { return {}; } }
  return null;
}
function blSave_(d) {
  var sh = blSheet_(), v = sh.getDataRange().getValues(), key = d.num || d.day, row = -1;
  for (var i = 1; i < v.length; i++) if (String(v[i][1] || '') === key || (!v[i][1] && String(v[i][0]) === key)) row = i + 1;
  var json = JSON.stringify(d); if (json.length > 49000) { var s = JSON.parse(json); s.lines.forEach(function (l) { delete l.top; }); json = JSON.stringify(s).slice(0, 49000); }
  var vals = [[d.day, d.num || '', d.at, d.source + (d.by ? ' · ' + d.by : ''), d.alert ? (d.noCmd ? 'PAS DE COMMANDE' : '⚠️ ÉCARTS') : '✅ OK', d.nEcarts, d.mailed || '', d.fileUrl || '', json]];
  if (row > 0) sh.getRange(row, 1, 1, 9).setValues(vals); else sh.appendRow(vals[0]);
}
function kbBlList_(n) {
  var v = blSheet_().getDataRange().getValues(), out = [];
  for (var i = v.length - 1; i >= 1 && out.length < (n || 20); i--) { try { out.push(JSON.parse(String(v[i][8] || '{}'))); } catch (e) {} }
  return { ok: true, list: out };
}
function kbBlConcord_(p) {
  var bc = String(p.blCode || '').trim(); if (!/^[A-Z]\d{4,6}$/.test(bc)) return { ok: false, error: 'code BL invalide' };
  var codes = String(p.codes == null ? '' : p.codes).split(/[,;+\s]+/).map(function (x) { return x.trim(); }).filter(function (x) { return /^[\w-]{1,12}$/.test(x); });
  var PV = { byCode: {} }; try { PV = flAutoReadPvttc_(); } catch (e) {}
  blConcWrite_(bc, String(p.blDes || '').slice(0, 120), codes, codes.map(function (c) { return (PV.byCode[c] || {}).des || ''; }).join(' + '), 'manuel (appli)', String(p._by || p.by || '').slice(0, 60));
  return { ok: true };
}
/** Relance le contrôle d'un BL déjà reçu (après un rapprochement) à partir du PDF rangé dans le Drive. */
function kbBlRecheck_(p) {
  var prev = blFindPrev_(String(p.key || ''));
  if (!prev || !prev.fileUrl) return { ok: false, error: 'BL introuvable' };
  var id = String(prev.fileUrl).match(/[-\w]{25,}/);
  if (!id) return { ok: false, error: 'PDF introuvable' };
  var blob = DriveApp.getFileById(id[0]).getBlob();
  return kbBlCheck_({ pdf: Utilities.base64Encode(blob.getBytes()), name: prev.name, source: prev.source || 'relance appli', by: p._by || p.by, force: p.force, quiet: true });
}

/* ═════════════════════════════ 7) MAIL D'ALERTE ═════════════════════════════ */
var BL_ST = {
  manquant:    { c: '#c62828', l: '❌ Non livré' },
  absent:      { c: '#c62828', l: '❌ Absent du BL' },
  absentProbable: { c: '#1565c0', l: '🔗 Probable' },
  moins:       { c: '#e65100', l: '⬇️ En moins' },
  plus:        { c: '#6a1b9a', l: '⬆️ En plus' },
  nonCommande: { c: '#6a1b9a', l: '➕ Non commandé' },
  rapprocher:  { c: '#1565c0', l: '🔗 À rapprocher' },
  aConfirmer:  { c: '#757575', l: '❔ À vérifier' },
  ok:          { c: '#2e7d32', l: '✅ OK' },
  ok0:         { c: '#9e9e9e', l: '— 0' }
};
function blMail_(d) {
  var probable = {};   // « commandé mais absent » probablement = une ligne du BL à rapprocher → affiché sous cette ligne
  d.missing.forEach(function (m) { if (m.status === 'absentProbable' && m.blCode) (probable[m.blCode] = probable[m.blCode] || []).push(m); });
  var bad = d.lines.filter(function (l) { return ['manquant', 'moins', 'plus', 'nonCommande', 'rapprocher', 'aConfirmer'].indexOf(l.status) >= 0; })
    .concat(d.missing.filter(function (m) { return m.status === 'absent'; }));
  var order = { manquant: 0, absent: 1, moins: 2, plus: 3, nonCommande: 4, rapprocher: 5, aConfirmer: 6 };
  bad.sort(function (a, b) { return (order[a.status] - order[b.status]) || String(a.des).localeCompare(String(b.des), 'fr'); });
  var td = 'padding:9px 10px;border-bottom:1px solid #eee;';
  var rows = bad.map(function (l) {
    var st = BL_ST[l.status] || BL_ST.ok;
    var att = l.attendu != null ? blFmt_(l.attendu) + (l.colis != null ? '<div style="font-size:12px;color:#777">' + blFmt_(l.colis, 1) + ' colis × ' + blFmt_(l.col, 2) + (l.rajColis ? ' (dont rajout ' + blFmt_(l.rajColis, 1) + ')' : '') + '</div>' : '') : '—';
    var liv = l.status === 'absent' ? '0' : blFmt_(l.qte);
    return '<tr><td style="' + td + 'white-space:nowrap"><span style="display:inline-block;background:' + st.c + ';color:#fff;border-radius:8px;padding:3px 8px;font-size:13px;font-weight:800">' + st.l + '</span></td>'
      + '<td style="' + td + 'font-size:15px;font-weight:700">' + rgEsc_(l.des) + '<div style="font-size:12px;color:#777;font-weight:400">'
      + rgEsc_([l.blCode ? 'BL ' + l.blCode : '', l.codes && l.codes.length ? 'code ' + l.codes.join('+') : (l.code ? 'code ' + l.code : ''), l.status === 'rapprocher' ? 'pas encore relié à un code Probon' : l.msg].filter(Boolean).join(' · ')) + '</div>'
      + (probable[l.blCode] ? '<div style="font-size:12px;color:#1565c0;font-weight:700;margin-top:2px">Probablement : ' + probable[l.blCode].map(function (m) { return rgEsc_(m.des) + ' (code ' + rgEsc_(m.code) + ', attendu ' + blFmt_(m.attendu) + ')'; }).join(' + ') + '</div>' : '')
      + (l.status === 'aConfirmer' && l.kbg ? '<div style="font-size:12px;color:#555;margin-top:2px">KBG : ' + rgEsc_(l.kbg) + '</div>' : '') + '</td>'
      + '<td style="' + td + 'text-align:right;font-size:18px;font-weight:900">' + att + '</td>'
      + '<td style="' + td + 'text-align:right;font-size:18px;font-weight:900;color:' + st.c + '">' + liv + '</td></tr>';
  }).join('');
  var prix = d.lines.filter(function (l) { return l.prixEcart; });
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:700px;color:#1b1b1b">'
    + '<div style="background:#c62828;color:#fff;border-radius:14px;padding:16px 20px"><div style="font-size:24px;font-weight:900">⚠️ BL Rungis du ' + rgEsc_(rgLong_(d.day)) + '</div>'
    + '<div style="font-size:16px;margin-top:2px">' + (d.noCmd ? 'Aucune commande KBG enregistrée pour ce jour — contrôle impossible' : '<b>' + d.nEcarts + ' écart(s)</b> avec la commande KBG' + (d.counts.rapprocher ? ' · ' + d.counts.rapprocher + ' produit(s) à rapprocher' : ''))
    + (d.num ? ' · BL ' + rgEsc_(d.num) : '') + '</div></div>'
    + '<p style="font-size:14px;color:#555;margin:10px 2px">Quantités en <b>kg ou pièces</b> (comme le BL). Attendu = colis commandés × colisage (commande 4h30' + (d.nRaj ? ' + rajouts F&amp;L de la veille' : '') + ').</p>'
    + (bad.length ? '<table role="presentation" width="100%" style="border-collapse:collapse;border:1px solid #e0e0e0">'
      + '<tr style="background:#fafafa"><th style="padding:8px 10px;text-align:left;font-size:12px">ÉTAT</th><th style="padding:8px 10px;text-align:left;font-size:12px">PRODUIT</th><th style="padding:8px 10px;text-align:right;font-size:12px">ATTENDU</th><th style="padding:8px 10px;text-align:right;font-size:12px">BL</th></tr>' + rows + '</table>' : '')
    + (prix.length ? '<div style="margin-top:14px;font-size:14px;color:#555"><b>Écarts de prix (info)</b> — prix BL vs prix d\'achat COMMANDE FL : '
      + prix.map(function (l) { return rgEsc_(l.des) + ' ' + blFmt_(l.prix) + ' € (KBG ' + blFmt_(l.prixKbg) + ' €)'; }).join(' · ') + '</div>' : '')
    + '<p style="font-size:14px;margin-top:14px">✅ ' + d.counts.ok + ' ligne(s) conforme(s) sur ' + d.nLines + '. '
    + (d.fileUrl ? '<a href="' + d.fileUrl + '" style="color:#1565c0;font-weight:700">Ouvrir le BL (PDF)</a>' : '') + '<br>Détail et rapprochements : appli Kelbongoo › Espace Rungis › 📄 Contrôle BL.</p>'
    + '<p style="color:#999;font-size:12px">Contrôle automatique Kelbongoo · ' + rgEsc_(d.source) + ' · ' + d.at + '</p></div>';
  var text = 'BL Rungis du ' + rgFr_(d.day) + ' — ' + d.nEcarts + ' écart(s)\n\n' + bad.map(function (l) {
    return (BL_ST[l.status] || {}).l + ' · ' + l.des + ' · attendu ' + (l.attendu != null ? blFmt_(l.attendu) : '—') + ' · BL ' + (l.status === 'absent' ? '0' : blFmt_(l.qte));
  }).join('\n');
  MailApp.sendEmail({ to: BL_ALERT_TO, subject: '⚠️ BL Rungis ' + rgFr_(d.day) + (d.noCmd ? ' : pas de commande KBG ce jour' : ' : ' + d.nEcarts + ' écart(s) avec la commande'), htmlBody: html, body: text, name: 'Kelbongoo' });
}

/* ═════════════════════════════ 8) ROUTAGE + ESSAIS ═════════════════════════════ */
/** Appelé par kbRungisRoute_ (KBG_Rungis.gs v1.4) pour les actions rungis_bl_*. */
function kbBlRoute_(p) {
  if (p.action === 'rungis_bl_check') return kbBlCheck_(p);
  if (p.action === 'rungis_bl_list') return kbBlList_(Number(p.n) || 20);
  if (p.action === 'rungis_bl_concord') { var r = kbBlConcord_(p); if (!r.ok || !p.key) return r; return kbBlRecheck_({ key: p.key, _by: p._by }); }
  if (p.action === 'rungis_bl_recheck') return kbBlRecheck_(p);
  return { ok: false, error: 'action BL inconnue' };
}
/** Essai depuis l'éditeur : contrôle le dernier PDF du dossier « BL Rungis » (aucun mail si tout est OK). */
function blTestDernier() {
  var it = blFolder_().getFiles(), last = null;
  while (it.hasNext()) { var f = it.next(); if (!last || f.getDateCreated() > last.getDateCreated()) last = f; }
  if (!last) { Logger.log('Dossier « BL Rungis » vide : dépose un BL PDF dedans (ou charge-le dans l\'appli).'); return; }
  var r = kbBlCheck_({ pdf: Utilities.base64Encode(last.getBlob().getBytes()), name: last.getName(), source: 'essai éditeur', force: true });
  Logger.log(JSON.stringify(r.ok ? { day: r.result.day, num: r.result.num, lignes: r.result.nLines, counts: r.result.counts, mail: r.result.mailed || 'non' } : r));
}
