/**
 * KBG_BL.gs — v1.2 (27/10/2026) — v1.2 : rapprochement BL ↔ commande du jour (nom + quantité + colisage + prix, 2 lignes BL pour 1 produit), « non livré » en gris (info),
 *   absents du BL vérifiés dans le PVTTC (version actuelle + 2 précédentes), attendu détaillé (kg/pce, colis × colisage, MU), écarts de prix en bas.
 * v1.1 (22/10/2026) — v1.1 : si le CODE PROBON du Sheet est le code article du BL (ex. œufs A00900), rapprochement direct — à ajouter dans le projet Apps Script « FL_Probon_Proxy »
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

/* ═════════════════════════════ 3) RAPPROCHEMENT BL ↔ CODE PROBON (v1.2) ═════════════════════════════
 * Le code du BL (A00xxx) n'est pas le code Probon interne. v1.2 : on se sert de TOUT ce qu'on sait —
 *   • la concordance déjà apprise (onglet CONCORDANCE BL),
 *   • la COMMANDE du jour : quantité attendue (colis × colisage), colisage (« 5KG » dans le BL = COL 5),
 *   • le PVTTC : désignation Rungis + prix d'achat (= prix net du BL),
 *   • le nom KBG.
 * Chaque ligne du BL reçoit un score pour chaque produit commandé ; affectation du meilleur au moins bon.
 * Un même produit KBG peut recevoir 2 lignes du BL (ex. CHOU FLEUR 11PC + CHOU FLEUR 8PC → quantités additionnées).
 * Relié tout seul si le score est net (et mémorisé dans CONCORDANCE BL si c'est bien le même produit). */
var BL_STOP = { BIO: 1, FR: 1, ES: 1, IT: 1, ITA: 1, KG: 1, PCE: 1, PC: 1, PIECE: 1, PIECES: 1, DE: 1, DU: 1, LA: 1, LE: 1, LES: 1, DES: 1, ET: 1, EN: 1, A: 1, AU: 1, G: 1, GR: 1, BQ: 1, BARQ: 1, BARQUETTE: 1, SACHET: 1, CAT: 1, CAL: 1, VARIETES: 1, VARIETE: 1, MULTIPLES: 1, MULTIPLE: 1, ESP: 1,
  AROMATIQUE: 1, LAVEE: 1, LAVE: 1, COLIS: 1, BOIS: 1, CORSE: 0, SELON: 1, ARRIVAGE: 1, COULEUR: 1, BOITE: 1, BOITES: 1 };
var BL_SYN = { RAINBOW: 'RAIMBOW', COLOREE: 'RAIMBOW', COLORE: 'RAIMBOW', CLEMENTINE: 'CLEMENTINE', CHANTECLERC: 'CHANTECLER', REINETTE: 'REINETTE' };
function blTok_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/\b(P|PDT)\b\.?\s*(DE\s+)?TERRE\b/g, 'POMME TERRE')
    .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ')
    .map(function (w) { if (w.length > 4 && /S$/.test(w)) w = w.slice(0, -1); return BL_SYN[w] || w; })   // pluriels : POMMES, OIGNONS, CAROTTES…
    .filter(function (w) { return w && !BL_STOP[w] && !/\d/.test(w) && w.length > 1; });
}
function blTokEq_(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length < 5 || b.length < 5) return false;
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
function blHead_(s) { return blTok_(s)[0] || ''; }
function blSim_(a, b) {
  var A = blTok_(a), B = blTok_(b); if (!A.length || !B.length) return 0;
  var ua = {}, ub = {}; A.forEach(function (w) { ua[w] = 1; }); B.forEach(function (w) { ub[w] = 1; });
  var ka = Object.keys(ua), kb = Object.keys(ub), inter = 0, usedB = {};
  ka.forEach(function (w) { for (var i = 0; i < kb.length; i++) if (!usedB[i] && blTokEq_(w, kb[i])) { usedB[i] = 1; inter++; return; } });
  var dice = 2 * inter / (ka.length + kb.length);
  return (blTokEq_(A[0], B[0]) ? 0.15 : 0) + dice;      // même 1er mot (le produit) = bonus
}
/** Colisage et unité écrits à la fin de la désignation du BL : « … 5KG » → {col:5, ua:'KG'}, « … 12PC » → {col:12, ua:'PCE'}. */
function blColOf_(des) {
  var m = String(des || '').match(/(\d+(?:[.,]\d+)?)\s*(KG|PCE|PC)\s*$/i);
  return m ? { col: Number(m[1].replace(',', '.')), ua: /KG/i.test(m[2]) ? 'KG' : 'PCE' } : { col: 0, ua: '' };
}
/** Unité d'un produit attendu : UA du PVTTC, sinon celle du BL, sinon d'après le type KBG. */
function blUnit_(x, PV, line) {
  var pv = (PV && PV.byCode && PV.byCode[x.code]) || {};
  var u = pv.ua || (line && line.ua) || (/PIECE/i.test(x.type || '') ? 'PCE' : 'KG');
  return /^P/i.test(u) ? 'pce' : 'kg';
}
/** Score d'une ligne du BL pour un produit attendu. */
function blScore_(l, x, PV, learned) {
  var pv = (PV.byCode || {})[x.code] || {};
  var sim = Math.max(blSim_(l.des, x.des), pv.des ? blSim_(l.des, pv.des) : 0);
  var h = blHead_(l.des);
  var head = !!h && (blTokEq_(h, blHead_(x.des)) || (!!pv.des && blTokEq_(h, blHead_(pv.des))));
  var s = sim, why = [];
  if (learned) { s += 0.6; why.push('concordance'); }
  var hi = Math.ceil((x.colis || 0) - 1e-9) * (x.col || 0), lo = Math.min(x.qty || 0, hi || x.qty || 0);
  if (l.qte > 0 && x.qty > 0 && (Math.abs(l.qte - hi) < 0.011 || Math.abs(l.qte - x.qty) < 0.011)) { s += 0.35; why.push('même quantité'); }
  else if (l.qte > 0 && x.qty > 0 && l.qte >= lo * (1 - BL_TOL) - 0.01 && l.qte <= (hi || x.qty) * (1 + BL_TOL) + 0.01) { s += 0.2; why.push('quantité proche'); }
  if (l.col && x.col && Math.abs(l.col - x.col) < 0.011) { s += 0.15; why.push('même colisage'); }
  var pa = pv.pa || x.pa; if (pa && l.prix && Math.abs(pa - l.prix) <= 0.02) { s += 0.2; why.push('même prix'); }
  return { code: String(x.code), s: Math.round(s * 100) / 100, sim: Math.round(sim * 100) / 100, head: head, learned: !!learned, why: why };
}
/** PVTTC : le produit Rungis qui EST cette ligne du BL (même nom, même prix, même colisage) — pour les lignes hors commande. */
function blPvIdentity_(l, PV) {
  var c = (PV.list || []).map(function (x) {
    var sim = blSim_(l.des, x.des), ok = blTokEq_(blHead_(l.des), blHead_(x.des)) && sim >= 0.8 && (!x.pa || Math.abs(x.pa - l.prix) <= 0.02) && (!l.col || !x.col || Math.abs(x.col - l.col) < 0.011);
    return ok ? { code: String(x.code), des: x.des, sim: sim } : null;
  }).filter(Boolean).sort(function (a, b) { return b.sim - a.sim; });
  return c.length && (c.length === 1 || c[0].sim - c[1].sim >= 0.1) ? c[0] : null;
}
/** Affecte chaque ligne du BL à un produit attendu.
 *  Retourne { asg: {blCode: {code, s, sim, head, learned, sure, why}}, top: {blCode: [suggestions]} } — fonction pure. */
function blMatch_(bl, exp, conc, PV) {
  var pairs = [], top = {};
  bl.lines.forEach(function (l) {
    var lc = (conc[l.code] || []).map(String), all = [];
    Object.keys(exp).forEach(function (code) {
      var learned = lc.indexOf(String(code)) >= 0 || String(l.code) === String(code);
      var p = blScore_(l, exp[code], PV, learned);
      if (!(p.learned || (p.head && p.sim >= 0.5) || p.sim >= 0.7)) return;
      p.blCode = l.code; all.push(p); pairs.push(p);
    });
    all.sort(function (a, b) { return b.s - a.s; });
    top[l.code] = all.slice(0, 6).map(function (p) { return { code: p.code, des: exp[p.code].des, sim: Math.round(p.s * 100), exp: true }; });
  });
  pairs.sort(function (a, b) { return b.s - a.s; });
  var asg = {}, byCode = {};
  pairs.forEach(function (p) {
    if (asg[p.blCode]) return;
    var taken = byCode[p.code];
    // 2e ligne du BL pour un produit déjà pris : seulement si c'est clairement le même produit (2 formats)
    if (taken && !(p.learned || (p.head && p.sim >= 0.8))) return;
    asg[p.blCode] = p; (byCode[p.code] = byCode[p.code] || []).push(p.blCode);
  });
  Object.keys(asg).forEach(function (bc) {
    var p = asg[bc], second = 0;
    pairs.forEach(function (q) { if (q.blCode === bc && q.code !== p.code && q.s > second) second = q.s; });
    p.second = second;
    p.sure = p.learned || (p.s >= 0.9 && p.s - second >= 0.15) || p.s >= 1.25;
  });
  return { asg: asg, top: top };
}

/* ═════════════════════════════ 4) COMPARAISON ═════════════════════════════ */
/** exp : {code: {code, des, prod, colis, col, qty, pa, cmdColis, rajColis, uv, type, estim}} — qty = colis × col (kg ou pièces).
 *  conc : {blCode: ["1043", …]}. Retourne { lines:[…], missing:[…], counts, learn:[…] } — fonction pure (testée hors Apps Script). */
function blCompare_(bl, exp, conc, PV, M) {
  PV = PV || { list: [], byCode: {} };
  M = M || blMatch_(bl, exp, conc, PV);
  var out = [], groups = {}, learn = [];
  bl.lines.forEach(function (l) {
    var p = M.asg[l.code];
    var r = { blCode: l.code, des: l.des, prix: l.prix, qte: l.qte, total: l.total, ua: l.ua || '', codes: [], status: '', msg: '', attendu: null, colis: null, col: null, ecart: 0, prixKbg: null, top: M.top[l.code] || [] };
    if (p && p.sure) {
      r.codes = [p.code]; r.match = p.learned ? 'concordance' : 'deviné';
      if (!p.learned) {
        r.why = p.why.join(' · ');
        if (p.head && p.sim >= 0.65) learn.push({ blCode: l.code, blDes: l.des, code: p.code, des: exp[p.code].des });
        else r.equiv = true;   // autre variété / autre format livré à la place (pas mémorisé)
      }
      (groups[p.code] = groups[p.code] || []).push(r);
    } else if (p) {
      r.status = 'rapprocher'; r.guess = p.code;
      r.msg = 'Probablement « ' + exp[p.code].des + ' » (code ' + p.code + ') — à confirmer';
    } else {
      var id = blPvIdentity_(l, PV), lc = (conc[l.code] || []);
      if (lc.length || id) r.codes = lc.length ? lc.map(String) : [id.code];
      r.pvDes = id ? id.des : '';
      r.status = l.qte > 0 ? 'nonCommande' : 'ok0';
      r.msg = l.qte > 0 ? 'Livré mais PAS dans la commande KBG du jour' : 'Ligne à 0 (non commandé)';
    }
    out.push(r);
  });
  Object.keys(groups).forEach(function (code) {
    var x = exp[code], rs = groups[code].sort(function (a, b) { return b.qte - a.qte; }), r = rs[0];
    var qte = rs.reduce(function (a, y) { return a + (Number(y.qte) || 0); }, 0);
    var colisE = Math.ceil((x.colis || 0) - 1e-9), hi = colisE * (x.col || 0), att = hi || x.qty;
    r.code = code; r.kbg = x.des; r.prod = x.prod; r.attendu = Math.round(att * 100) / 100; r.besoin = Math.round(x.qty * 100) / 100;
    r.colis = colisE; r.colisCmd = Math.round((x.colis || 0) * 10) / 10; r.col = x.col; r.rajColis = x.rajColis || 0;
    r.unit = blUnit_(x, PV, r); r.estim = x.estim || 0; r.uv = x.uv || ''; r.qteTot = Math.round(qte * 100) / 100;
    if (rs.length > 1) { r.autres = rs.slice(1).map(function (y) { return { blCode: y.blCode, des: y.des, qte: y.qte }; });
      rs.slice(1).forEach(function (y) { y.status = 'lie'; y.code = code; y.kbg = x.des; y.msg = 'Compté avec « ' + r.des + ' » (même produit KBG)'; }); }
    r.prixKbg = ((PV.byCode || {})[code] || {}).pa || x.pa || null;
    var lo = Math.min(x.qty, att) * (1 - BL_TOL) - 0.01, up = att * (1 + BL_TOL) + 0.01;
    if (x.unknown) { r.status = 'aConfirmer'; r.msg = 'Quantité à confirmer (produit vendu absent du Sheet)'; }
    else if (att > 0 && qte <= 0) { r.status = 'manquant'; r.ecart = -att; r.msg = 'Non livré : Rungis a mis 0 sur le BL (pour info)'; }
    else if (qte < lo) { r.status = 'moins'; r.ecart = Math.round((qte - att) * 100) / 100; r.msg = 'Livré en MOINS'; }
    else if (qte > up) { r.status = 'plus'; r.ecart = Math.round((qte - att) * 100) / 100; r.msg = 'Livré en PLUS'; }
    else { r.status = 'ok'; r.msg = 'Conforme'; }
    if ((r.status === 'moins' || r.status === 'manquant') && r.rajColis > 0 && Math.abs((att - qte) - r.rajColis * (x.col || 0)) <= Math.max(0.5, att * BL_TOL))
      r.msg += ' — le rajout de la veille (' + blFmt_(r.rajColis, 1) + ' colis) n\'a pas été livré';
    if (r.equiv) r.msg += ' · livré à la place : « ' + r.des + ' »';
    rs.forEach(function (y) { if (y.prixKbg == null && y !== r) y.prixKbg = r.prixKbg; if (y.prixKbg && y.prix && Math.abs(y.prix - y.prixKbg) > BL_PRIX_TOL) y.prixEcart = Math.round((y.prix - y.prixKbg) * 100) / 100; });
    if (r.prixKbg && r.prix && Math.abs(r.prix - r.prixKbg) > BL_PRIX_TOL) r.prixEcart = Math.round((r.prix - r.prixKbg) * 100) / 100;
  });
  var missing = Object.keys(exp).filter(function (c) { return !groups[c] && exp[c].qty > 0 && !exp[c].unknown; }).map(function (c) {
    var x = exp[c], colisE = Math.ceil((x.colis || 0) - 1e-9);
    var m = { code: c, des: x.des, prod: x.prod, colis: colisE, colisCmd: Math.round((x.colis || 0) * 10) / 10, col: x.col, attendu: Math.round((colisE * (x.col || 0) || x.qty) * 100) / 100,
      besoin: Math.round(x.qty * 100) / 100, rajColis: x.rajColis || 0, unit: blUnit_(x, PV), estim: x.estim || 0, uv: x.uv || '', status: 'absent', msg: 'Commandé mais ABSENT du BL' };
    var g = out.filter(function (r) { return r.status === 'rapprocher' && r.guess === c; })[0];
    if (g) { m.status = 'absentProbable'; m.blCode = g.blCode; m.msg = 'Probablement « ' + g.des + ' » du BL (' + blFmt_(g.qte) + ') — à confirmer'; }
    return m;
  });
  var res = { lines: out, missing: missing, learn: learn };
  res.counts = blCount_(res);
  return res;
}
/** Absents du BL : sont-ils dans la mercuriale PVTTC ? (version actuelle puis les 2 précédentes) */
function blPvCheck_(missing, H) {
  if (!H || !H.length) return;
  var cur = H[0], d = function (v) { return 'PVTTC du ' + rgFr_(v.date) + (v.tab ? ' (' + v.tab + ')' : ''); };
  missing.forEach(function (m) {
    if (m.status !== 'absent' || !/^\d{4,}$/.test(String(m.code))) return;   // codes Probon (≥ 4 chiffres) ; œufs A00900 / anciens formats 1-4 : pas dans le PVTTC
    if (cur.codes[m.code]) { m.pv = 'cur'; m.pvMsg = 'Bien dans la mercuriale (' + d(cur) + ') : Rungis ne l\'a pas livré.'; return; }
    var old = H.slice(1).filter(function (v) { return v.codes[m.code]; })[0];
    m.status = 'horsPvttc';
    if (old) { m.pv = 'old'; m.pvMsg = 'Présent dans la ' + d(old) + ', plus dans la ' + d(cur) + ' : Rungis l\'a retiré. On le vend encore sur le stock restant… ou c\'est une erreur (produit à passer inactif dans COMMANDE FL ?).'; }
    else { m.pv = 'none'; m.pvMsg = 'Absent de la ' + d(cur) + (H.length > 1 ? ' et des ' + (H.length - 1) + ' version(s) précédente(s) (depuis le ' + rgFr_(H[H.length - 1].date) + ')' : '') + ' : on le vend sur le stock restant, ou erreur de code Probon dans COMMANDE FL.'; }
  });
}
function blCount_(res) {
  var cnt = { ok: 0, ok0: 0, lie: 0, moins: 0, plus: 0, manquant: 0, absent: 0, horsPvttc: 0, absentProbable: 0, nonCommande: 0, rapprocher: 0, aConfirmer: 0, prix: 0 };
  res.lines.forEach(function (r) { if (cnt[r.status] != null) cnt[r.status]++; if (r.prixEcart) cnt.prix++; });
  res.missing.forEach(function (m) { cnt[m.status] = (cnt[m.status] || 0) + 1; });
  res.nEcarts = cnt.moins + cnt.plus + cnt.absent + cnt.horsPvttc + cnt.nonCommande;   // « non livré » (0 sur le BL) = pour info
  res.alert = res.nEcarts > 0 || cnt.rapprocher > 0 || cnt.manquant > 0;
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
  var add = function (code, des, prod, colis, col, pa, kind, unknown, more) {
    code = String(code || '').trim(); if (!code) return false;
    var x = exp[code] || (exp[code] = { code: code, des: des, prod: prod, colis: 0, col: Number(col) || 0, qty: 0, pa: Number(pa) || 0, cmdColis: 0, rajColis: 0, unknown: false, uv: '', type: '', estim: 0 });
    if (more) { if (more.uv && !x.uv) x.uv = more.uv; if (more.type && !x.type) x.type = more.type; x.estim += Number(more.estim) || 0; }
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
      if (!add(x[0], des, x[1], x[3], x[4], x[7], 'cmd', hors && !(Number(x[3]) > 0), { uv: String(x[5] || ''), type: String(x[6] || ''), estim: x[10] })) noCode.push({ des: des, prod: x[1], colis: x[3], hors: hors });
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
  bl.lines.forEach(function (l) { var c = blColOf_(l.des); l.col = c.col; l.ua = c.ua; });   // v1.2 — colisage lu sur le BL (« 5KG »)
  var PV = { list: [], byCode: {} }; try { PV = flAutoReadPvttc_(); } catch (e) {}
  var E = blExpected_(bl.date, PV);
  var conc = blConcRead_();
  var res = blCompare_(bl, E.exp, conc, PV);
  // v1.2 — mémorise les rapprochements sûrs (même produit) pour les prochains BL
  res.learn.forEach(function (x) { if (!(conc[x.blCode] && conc[x.blCode].length)) { try { blConcWrite_(x.blCode, x.blDes, [x.code], x.des, 'auto v1.2 (commande du jour : nom + quantité + colisage + prix)', 'contrôle BL'); } catch (e) {} } });
  // Produits vendus hors Sheet (sans code) : rapprochés par le nom pour info « quantité à confirmer »
  res.lines.forEach(function (r) {
    if (r.status !== 'rapprocher' && r.status !== 'nonCommande') return;
    var h = E.noCode.filter(function (n) { return blSim_(r.des, n.des) >= 0.75 && blTokEq_(blTok_(r.des)[0] || '', blTok_(n.des)[0] || ''); })[0];
    if (h) { r.status = 'aConfirmer'; r.kbg = h.des; r.msg = h.hors ? 'Produit vendu absent du Sheet (commandé « quantité à confirmer ») — à vérifier' : 'Rajout sans code Probon — à vérifier'; }
  });
  // v1.2 — absents du BL : contrôle dans la mercuriale PVTTC (version actuelle + 2 précédentes)
  var H = []; try { H = blPvHist_(PV); } catch (e) { res.pvErr = String(e.message || e); }
  blPvCheck_(res.missing, H);
  res.counts = blCount_(res);
  delete res.learn;
  var data = { v: '1.2', day: bl.date, num: bl.num, ref: bl.ref, totalHt: bl.totalHt, nLines: bl.lines.length, snapFound: E.snapFound, sentAt: E.sentAt, nRaj: E.nRaj,
    pvVersions: H.map(function (v) { return { date: v.date, tab: v.tab, n: v.n }; }), pvErr: res.pvErr || '',
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
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify([d.lines.map(function (l) { return [l.blCode, l.status, l.qte]; }), d.missing.map(function (m) { return [m.code, m.status]; })]))).slice(0, 16);
}

/* ═════════════════════════════ 6 bis) VERSIONS DU PVTTC (v1.2) ═════════════════════════════
 * Le PVTTC est réécrit par Rungis ~2 fois par semaine (un seul onglet). Pour savoir si un produit « absent du BL »
 * était encore dans la mercuriale, on garde les listes de codes des versions successives dans l'onglet « PVTTC VERSIONS »
 * (Sheet COMMANDE FL) : • à chaque contrôle, la version actuelle si elle a changé ;
 *                     • une fois, reprise de l'historique Drive du fichier (révisions), pour avoir tout de suite les 2 précédentes.
 * On ne remonte jamais au-delà de 2 versions précédentes. */
var BL_PVH_TAB = 'PVTTC VERSIONS';
function blPvhSheet_() {
  var sh = blSs_().getSheetByName(BL_PVH_TAB);
  if (!sh) {
    sh = blSs_().insertSheet(BL_PVH_TAB);
    sh.getRange(1, 1, 1, 6).setValues([['VERSION DU', 'ONGLET', 'SOURCE', 'NB CODES', 'SIGNATURE', 'CODES']]).setFontWeight('bold').setBackground('#1565c0').setFontColor('#fff');
    sh.setFrozenRows(1);
  }
  return sh;
}
function blPvSig_(codes) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, codes.join(','))).slice(0, 12); }
function blPvhRead_(sh) {
  var v = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < v.length; i++) {
    if (!v[i][4]) continue;
    var codes = {}; String(v[i][5] || '').split(',').forEach(function (c) { if (c) codes[c] = 1; });
    out.push({ date: v[i][0] instanceof Date ? rgIso_(v[i][0]) : String(v[i][0]).slice(0, 10), tab: String(v[i][1] || ''), src: String(v[i][2] || ''), n: Number(v[i][3]) || 0, sig: String(v[i][4]), codes: codes });
  }
  return out;
}
/** Versions connues, de la plus récente à la plus ancienne (actuelle + 2 précédentes au plus). */
function blPvHist_(PV) {
  var sh = blPvhSheet_(), known = blPvhRead_(sh);
  var codes = (PV.list || []).map(function (x) { return String(x.code); }).sort(), sig = blPvSig_(codes);
  if (codes.length && !known.some(function (k) { return k.sig === sig; })) {
    var upd = rgIso_(new Date()); try { upd = rgIso_(DriveApp.getFileById(KBA.PV_SS_ID).getLastUpdated()); } catch (e) {}
    sh.appendRow([upd, PV.tab || '', 'lecture contrôle BL', codes.length, sig, codes.join(',')]);
    known.push({ date: upd, tab: PV.tab || '', n: codes.length, sig: sig, codes: codes.reduce(function (m, c) { m[c] = 1; return m; }, {}) });
  }
  var props = PropertiesService.getScriptProperties();
  if (known.length < 3 && !props.getProperty('BL_PVH_BOOT')) {
    try { blPvBoot_(sh, known); } catch (e) { Logger.log('PVTTC historique Drive : ' + e.message); }
    props.setProperty('BL_PVH_BOOT', new Date().toISOString());
    known = blPvhRead_(sh);
  }
  var bySig = {}, list = [];
  known.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  // la version actuelle en tête, puis les précédentes (signatures différentes)
  var cur = known.filter(function (k) { return k.sig === sig; })[0];
  if (cur) { list.push(cur); bySig[cur.sig] = 1; }
  known.forEach(function (k) { if (!bySig[k.sig] && list.length < 3) { bySig[k.sig] = 1; list.push(k); } });
  return list;
}
/** Reprise unique de l'historique Drive du PVTTC (révisions du fichier, export CSV) : 2 versions précédentes au plus. */
function blPvBoot_(sh, known) {
  var tok = ScriptApp.getOAuthToken(), H = { headers: { Authorization: 'Bearer ' + tok }, muteHttpExceptions: true };
  var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + KBA.PV_SS_ID + '/revisions?pageSize=200&fields=revisions(id,modifiedTime,exportLinks)', H);
  if (r.getResponseCode() !== 200) throw new Error('révisions Drive : HTTP ' + r.getResponseCode());
  var revs = (JSON.parse(r.getContentText()).revisions || []).filter(function (x) { return x.exportLinks && x.exportLinks['text/csv']; });
  revs.sort(function (a, b) { return a.modifiedTime < b.modifiedTime ? 1 : -1; });
  var seen = {}; known.forEach(function (k) { seen[k.sig] = 1; });
  var kept = 0, fetched = 0, lastDay = '';
  for (var i = 1; i < revs.length && kept < 2 && fetched < 10; i++) {          // i = 0 : version actuelle (déjà connue)
    var day = String(revs[i].modifiedTime).slice(0, 10); if (day === lastDay) continue; lastDay = day;
    var c = UrlFetchApp.fetch(revs[i].exportLinks['text/csv'], H); fetched++;
    if (c.getResponseCode() !== 200) continue;
    var rows = Utilities.parseCsv(c.getContentText()), hdr = (rows[0] || []).map(function (h) { return String(h).trim().toUpperCase(); }), ci = hdr.indexOf('CODE');
    if (ci < 0) continue;
    var codes = rows.slice(1).map(function (x) { return parseInt(x[ci], 10); }).filter(function (n) { return n > 0; }).map(String).sort();
    var sg = blPvSig_(codes); if (!codes.length || seen[sg]) continue;
    seen[sg] = 1; kept++;
    sh.appendRow([day, '', 'historique Drive (révision ' + revs[i].id + ')', codes.length, sg, codes.join(',')]);
  }
}
/** Essai éditeur : affiche les versions PVTTC connues. */
function blTestPvttc() {
  var PV = flAutoReadPvttc_(), H = blPvHist_(PV);
  Logger.log(H.map(function (v) { return v.date + ' · ' + v.tab + ' · ' + v.n + ' codes'; }).join('\n'));
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
  absent:      { c: '#c62828', l: '❌ Absent du BL' },
  horsPvttc:   { c: '#ef6c00', l: '📋 Plus au PVTTC' },
  moins:       { c: '#e65100', l: '⬇️ En moins' },
  plus:        { c: '#6a1b9a', l: '⬆️ En plus' },
  nonCommande: { c: '#6a1b9a', l: '➕ Non commandé' },
  rapprocher:  { c: '#1565c0', l: '🔗 À confirmer' },
  absentProbable: { c: '#1565c0', l: '🔗 Probable' },
  aConfirmer:  { c: '#757575', l: '❔ À vérifier' },
  manquant:    { c: '#9e9e9e', l: '— Non livré (info)' },
  lie:         { c: '#2e7d32', l: '✅ OK' },
  ok:          { c: '#2e7d32', l: '✅ OK' },
  ok0:         { c: '#9e9e9e', l: '— 0' }
};
/** « 36 kg » + détail « 6 colis de 6 kg · pour faire 37 MU (sachet 180g-220g) ». */
function blAttHtml_(l) {
  if (l.attendu == null) return '<span style="color:#999">—</span>';
  var u = l.unit || 'kg', d = [];
  if (l.colis != null && l.col) d.push(blFmt_(l.colis, 0) + ' colis de ' + blFmt_(l.col) + ' ' + u + (l.colisCmd && Math.abs(l.colisCmd - l.colis) > 0.05 ? ' (besoin ' + blFmt_(l.colisCmd, 1) + ' colis)' : ''));
  if (l.estim) d.push('pour faire ' + blFmt_(l.estim, 0) + ' MU' + (l.uv ? ' · ' + rgEsc_(l.uv) : ''));
  if (l.rajColis) d.push('dont rajout de la veille : ' + blFmt_(l.rajColis, 1) + ' colis');
  return '<div style="font-size:19px;font-weight:900;white-space:nowrap">' + blFmt_(l.attendu) + ' ' + u + '</div>'
    + (d.length ? '<div style="font-size:12px;color:#666;line-height:1.35">' + d.join('<br>') + '</div>' : '');
}
function blMail_(d) {
  var probable = {};
  d.missing.forEach(function (m) { if (m.status === 'absentProbable' && m.blCode) (probable[m.blCode] = probable[m.blCode] || []).push(m); });
  var main = d.lines.filter(function (l) { return ['moins', 'plus', 'nonCommande', 'rapprocher', 'aConfirmer'].indexOf(l.status) >= 0; })
    .concat(d.missing.filter(function (m) { return m.status === 'absent' || m.status === 'horsPvttc'; }));
  var info = d.lines.filter(function (l) { return l.status === 'manquant'; });
  var order = { absent: 0, horsPvttc: 1, moins: 2, plus: 3, nonCommande: 4, rapprocher: 5, aConfirmer: 6 };
  main.sort(function (a, b) { return (order[a.status] - order[b.status]) || String(a.kbg || a.des).localeCompare(String(b.kbg || b.des), 'fr'); });
  var td = 'padding:10px;border-bottom:1px solid #eee;vertical-align:top;';
  var row = function (l, grey) {
    var st = BL_ST[l.status] || BL_ST.ok, isMiss = l.status === 'absent' || l.status === 'horsPvttc';
    var titre = isMiss ? l.des : (l.kbg || l.des);
    var sub = [];
    if (!isMiss && l.kbg) sub.push('BL : ' + rgEsc_(l.des) + ' (' + rgEsc_(l.blCode) + ')' + (l.autres ? ' + ' + l.autres.map(function (y) { return rgEsc_(y.des) + ' (' + blFmt_(y.qte) + ')'; }).join(' + ') : ''));
    else if (!isMiss) sub.push('BL ' + rgEsc_(l.blCode) + (l.pvDes ? ' · PVTTC : ' + rgEsc_(l.pvDes) : ''));
    var code = l.code || (l.codes && l.codes[0]) || ''; if (code) sub.push('code Probon ' + rgEsc_(code));
    if (l.prod) sub.push(rgEsc_(l.prod));
    var msg = l.pvMsg || l.msg || '';
    var blCell = isMiss ? '0' : blFmt_(l.qteTot != null ? l.qteTot : l.qte) + (l.unit ? ' ' + l.unit : (l.ua ? ' ' + (l.ua === 'KG' ? 'kg' : 'pce') : ''));
    return '<tr style="' + (grey ? 'color:#888' : '') + '"><td style="' + td + 'white-space:nowrap"><span style="display:inline-block;background:' + st.c + ';color:#fff;border-radius:8px;padding:3px 8px;font-size:13px;font-weight:800">' + st.l + '</span></td>'
      + '<td style="' + td + '"><div style="font-size:16px;font-weight:800">' + rgEsc_(titre) + '</div><div style="font-size:12px;color:#777">' + sub.join(' · ') + '</div>'
      + (msg ? '<div style="font-size:13px;font-weight:700;color:' + (grey ? '#888' : st.c) + ';margin-top:3px">' + rgEsc_(msg) + '</div>' : '')
      + (l.why ? '<div style="font-size:11px;color:#999">relié d\'après la commande : ' + rgEsc_(l.why) + '</div>' : '')
      + (probable[l.blCode] ? '<div style="font-size:12px;color:#1565c0;font-weight:700;margin-top:2px">Probablement : ' + probable[l.blCode].map(function (m) { return rgEsc_(m.des) + ' (code ' + rgEsc_(m.code) + ')'; }).join(' + ') + '</div>' : '')
      + '</td><td style="' + td + 'text-align:right">' + blAttHtml_(l) + '</td>'
      + '<td style="' + td + 'text-align:right;font-size:19px;font-weight:900;white-space:nowrap;color:' + (grey ? '#888' : st.c) + '">' + blCell + '</td></tr>';
  };
  var head = '<tr style="background:#fafafa"><th style="padding:8px 10px;text-align:left;font-size:12px">ÉTAT</th><th style="padding:8px 10px;text-align:left;font-size:12px">PRODUIT</th><th style="padding:8px 10px;text-align:right;font-size:12px">ATTENDU</th><th style="padding:8px 10px;text-align:right;font-size:12px">BL</th></tr>';
  var tbl = function (rows) { return '<table role="presentation" width="100%" style="border-collapse:collapse;border:1px solid #e0e0e0">' + head + rows + '</table>'; };
  var prix = d.lines.filter(function (l) { return l.prixEcart; });
  var bad = d.nEcarts > 0 || d.noCmd;
  var pv = (d.pvVersions || []).length ? 'Mercuriale PVTTC contrôlée : ' + d.pvVersions.map(function (v) { return rgFr_(v.date) + (v.tab ? ' (' + rgEsc_(v.tab) + ')' : ''); }).join(', ') + '.' : '';
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;color:#1b1b1b">'
    + '<div style="background:' + (bad ? '#c62828' : '#546e7a') + ';color:#fff;border-radius:14px;padding:16px 20px"><div style="font-size:24px;font-weight:900">' + (bad ? '⚠️' : 'ℹ️') + ' BL Rungis du ' + rgEsc_(rgLong_(d.day)) + '</div>'
    + '<div style="font-size:16px;margin-top:2px">' + (d.noCmd ? 'Aucune commande KBG enregistrée pour ce jour — contrôle impossible' : '<b>' + d.nEcarts + ' écart(s)</b> avec la commande KBG' + (d.counts.rapprocher ? ' · ' + d.counts.rapprocher + ' à confirmer' : '') + (info.length ? ' · ' + info.length + ' non livré(s) pour info' : ''))
    + (d.num ? ' · BL ' + rgEsc_(d.num) : '') + '</div></div>'
    + '<p style="font-size:14px;color:#555;margin:10px 2px">Quantités en <b>kg ou pièces</b> comme sur le BL. Attendu = colis commandés × colisage (commande 4h30' + (d.nRaj ? ' + rajouts F&amp;L de la veille' : '') + ').</p>'
    + (main.length ? tbl(main.map(function (l) { return row(l, false); }).join('')) : '')
    + (info.length ? '<div style="margin-top:16px;font-size:15px;font-weight:800;color:#888">Pour info — non livrés (Rungis a mis 0 sur le BL)</div>' + tbl(info.map(function (l) { return row(l, true); }).join('')) : '')
    + '<p style="font-size:14px;margin-top:14px">✅ ' + (d.counts.ok + (d.counts.lie || 0)) + ' ligne(s) conforme(s) sur ' + d.nLines + '. '
    + (d.fileUrl ? '<a href="' + d.fileUrl + '" style="color:#1565c0;font-weight:700">Ouvrir le BL (PDF)</a>' : '') + '<br>Détail et rapprochements : appli Kelbongoo › Espace Rungis › 📄 Contrôle BL.'
    + (pv ? '<br><span style="font-size:12px;color:#777">' + pv + '</span>' : '') + '</p>'
    + (prix.length ? '<div style="margin-top:18px;border-top:2px solid #eee;padding-top:10px"><div style="font-size:14px;font-weight:800;color:#555">Écarts de prix (info) — prix net du BL ≠ prix d\'achat PVTTC</div>'
      + '<table role="presentation" style="border-collapse:collapse;font-size:13px;color:#555;margin-top:4px">' + prix.map(function (l) {
        return '<tr><td style="padding:3px 10px 3px 0">' + rgEsc_(l.kbg || l.des) + '</td><td style="padding:3px 10px;text-align:right">BL <b>' + blFmt_(l.prix) + ' €</b></td><td style="padding:3px 10px;text-align:right">PVTTC ' + blFmt_(l.prixKbg) + ' €</td><td style="padding:3px 0;text-align:right;color:' + (l.prixEcart > 0 ? '#c62828' : '#2e7d32') + '">' + (l.prixEcart > 0 ? '+' : '') + blFmt_(l.prixEcart) + ' €</td></tr>'; }).join('') + '</table></div>' : '')
    + '<p style="color:#999;font-size:12px;margin-top:14px">Contrôle automatique Kelbongoo v' + rgEsc_(d.v || '') + ' · ' + rgEsc_(d.source) + ' · ' + d.at + '</p></div>';
  var line = function (l) { return (BL_ST[l.status] || {}).l + ' · ' + (l.kbg || l.des) + ' · attendu ' + (l.attendu != null ? blFmt_(l.attendu) + ' ' + (l.unit || '') : '—') + ' · BL ' + ((l.status === 'absent' || l.status === 'horsPvttc') ? '0' : blFmt_(l.qteTot != null ? l.qteTot : l.qte)) + (l.pvMsg ? ' · ' + l.pvMsg : ''); };
  var text = 'BL Rungis du ' + rgFr_(d.day) + ' — ' + d.nEcarts + ' écart(s)\n\n' + main.map(line).join('\n') + (info.length ? '\n\nPour info (non livrés) :\n' + info.map(line).join('\n') : '');
  MailApp.sendEmail({ to: BL_ALERT_TO, subject: (bad ? '⚠️' : 'ℹ️') + ' BL Rungis ' + rgFr_(d.day) + (d.noCmd ? ' : pas de commande KBG ce jour' : ' : ' + d.nEcarts + ' écart(s) avec la commande' + (info.length ? ' · ' + info.length + ' non livré(s)' : '')), htmlBody: html, body: text, name: 'Kelbongoo' });
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
