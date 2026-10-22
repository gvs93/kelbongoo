/**
 * KBG_BL_Relais_achat.gs — v1.0 (22/10/2026)
 * ---------------------------------------------------------------------------------------------
 * À installer dans un NOUVEAU projet Apps Script créé EN ÉTANT CONNECTÉ AVEC achat@probon.fr
 * (script.google.com › Nouveau projet › nommer « KBG BL Relais »). Un script ne lit que la boîte
 * du compte qui l'a créé : c'est pour ça qu'il vit dans achat@ et pas dans FL_Probon_Proxy (hg@).
 *
 * Toutes les 5 minutes : cherche les mails de gestion@probon.fr dont l'objet contient « BL » avec un PDF,
 * envoie le PDF au contrôle (FL_Probon_Proxy › KBG_BL.gs, action rungis_bl_check), puis pose l'étiquette
 * « KBG-BL-controle » sur le fil (jamais contrôlé deux fois). C'est FL_Probon_Proxy qui compare au bon de
 * commande et envoie l'alerte à rr@pribon.org + hg@probon.fr s'il y a une incohérence.
 *
 * Installation (une fois) :
 *  1. Coller ce fichier.
 *  2. ⚙️ Paramètres du projet › Propriétés du script › ajouter :
 *        KBG_FL_EXEC_URL = l'URL /exec de FL_Probon_Proxy (la même que dans l'appli / Cloud Shell)
 *        KBG_SECRET      = la valeur de la propriété KBG_SECRET de FL_Probon_Proxy
 *  3. Exécuter blRelaisTest (autoriser Gmail + accès externe) → regarde le journal.
 *  4. Exécuter blRelaisInstall (déclencheur toutes les 5 min).
 * Rien n'est supprimé ni déplacé dans la boîte achat@ : seulement une étiquette.
 */
var BLR = {
  QUERY: 'from:gestion@probon.fr subject:BL has:attachment newer_than:3d -label:kbg-bl-controle -label:kbg-bl-erreur',
  LABEL: 'KBG-BL-controle',
  LABEL_ERR: 'KBG-BL-erreur',
  ERR_TO: 'hg@probon.fr',
  TZ: 'Europe/Paris',
  MAX_TRIES: 3
};

function blRelaisScan() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('KBG_FL_EXEC_URL'), secret = props.getProperty('KBG_SECRET');
  if (!url || !secret) throw new Error('Propriétés du script KBG_FL_EXEC_URL et KBG_SECRET à renseigner (voir en-tête).');
  var lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) return [];
  var done = [];
  try {
    var lbl = GmailApp.getUserLabelByName(BLR.LABEL) || GmailApp.createLabel(BLR.LABEL);
    var lblErr = GmailApp.getUserLabelByName(BLR.LABEL_ERR) || GmailApp.createLabel(BLR.LABEL_ERR);
    GmailApp.search(BLR.QUERY, 0, 10).forEach(function (th) {
      var ok = true, errs = [];
      th.getMessages().forEach(function (msg) {
        if (!/\bBL\b/i.test(msg.getSubject()) || !/gestion@probon\.fr/i.test(msg.getFrom())) return;
        msg.getAttachments({ includeInlineImages: false }).forEach(function (a) {
          if (!/pdf/i.test(a.getContentType()) && !/\.pdf$/i.test(a.getName())) return;
          var payload = {
            secret: secret, action: 'rungis_bl_check', pdf: Utilities.base64Encode(a.getBytes()), name: a.getName(),
            subject: msg.getSubject(), mailDate: Utilities.formatDate(msg.getDate(), BLR.TZ, 'yyyy-MM-dd'),
            source: 'mail achat@', by: 'relais achat@'
          };
          var j = {};
          try {
            var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: JSON.stringify(payload), muteHttpExceptions: true, followRedirects: true });
            j = JSON.parse(res.getContentText());
          } catch (e) { j = { ok: false, error: String(e && e.message || e) }; }
          if (!j || !j.ok) { ok = false; errs.push(a.getName() + ' : ' + ((j && j.error) || 'réponse invalide')); }
          else done.push(a.getName() + ' → ' + (j.result && j.result.alert ? '⚠️ ' + j.result.nEcarts + ' écart(s)' : '✅ OK'));
        });
      });
      if (ok) { th.addLabel(lbl); return; }
      var key = 'BLR_TRY_' + th.getId(), n = Number(props.getProperty(key) || 0) + 1;
      props.setProperty(key, String(n));
      if (n >= BLR.MAX_TRIES) {
        th.addLabel(lblErr); props.deleteProperty(key);
        MailApp.sendEmail(BLR.ERR_TO, '⚠️ BL Rungis non contrôlé automatiquement : « ' + th.getFirstMessageSubject() + ' »',
          'Le BL n\'a pas pu être contrôlé après ' + n + ' essais :\n' + errs.join('\n') +
          '\n\nCharge-le à la main : appli Kelbongoo › Espace Rungis › 📄 Contrôle BL.\n(Fil étiqueté « ' + BLR.LABEL_ERR + ' » dans achat@ ; retire l\'étiquette pour réessayer.)');
      }
    });
  } finally { lock.releaseLock(); }
  return done;
}

/** Essai : lance une fois et affiche le résultat dans le journal. */
function blRelaisTest() {
  var r = blRelaisScan();
  Logger.log(r.length ? r.join('\n') : 'Aucun BL non contrôlé dans les 3 derniers jours (fils déjà étiquetés « ' + BLR.LABEL + ' » ignorés).');
}

/** Déclencheur toutes les 5 minutes (relançable sans doublon). */
function blRelaisInstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'blRelaisScan') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('blRelaisScan').timeBased().everyMinutes(5).create();
  Logger.log('✅ Déclencheur installé : blRelaisScan toutes les 5 minutes.');
}
