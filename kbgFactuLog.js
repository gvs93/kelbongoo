// kbgFactuLog — Cloud Function (projet distribkbg, europe-west1)
// Reçoit le journal de facturation web (module PrestaShop kbfacturation ≥ 1.2.0, script du serveur 98)
// et l'écrit dans Firestore pour le suivi Master de l'appli :
//   facturation_events/{uid}         une ligne par événement (idempotent : renvoyer l'historique ne crée pas de doublon)
//   facturation_orders/{REFERENCE}   état courant de chaque commande web (dernier événement, montants, erreurs)
// Version 1.1 — 27/10/2026 (+ kbgFacturerWeb : l'appli déclenche la facturation complète d'une commande web)
//
// À ajouter dans functions/index.js :
//   exports.kbgFactuLog = require("./kbgFactuLog").kbgFactuLog;
// Secret (= le « Secret HMAC » affiché dans la configuration du module kbfacturation) :
//   firebase functions:secrets:set FACTU_LOG_SECRET
// Déploiement : firebase deploy --only functions:kbgFactuLog

const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

if (!admin.apps.length) admin.initializeApp();
const FACTU_LOG_SECRET = defineSecret("FACTU_LOG_SECRET");

const STATUT = { // action réussie -> statut de la commande (simulations / lectures / tests ne changent pas l'état)
  appliquer: "facturee", appliquer_pdv: "facturee", manuel: "facturee", facturer: "facturee",
  capturer: "capturee",
};
const str = (v, n = 300) => String(v == null ? "" : v).slice(0, n);

exports.kbgFactuLog = onRequest(
  { region: "europe-west1", secrets: [FACTU_LOG_SECRET], invoker: "public", maxInstances: 2 },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
    const sig = String(req.get("X-KBG-Signature") || "");
    const expected = crypto.createHmac("sha256", FACTU_LOG_SECRET.value()).update(req.rawBody).digest("hex");
    const a = Buffer.from(sig, "hex"), b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: "signature" });

    const body = req.body || {};
    if (Math.abs(Date.now() / 1000 - Number(body.ts || 0)) > 600) return res.status(400).json({ ok: false, error: "ts" });
    const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
    if (!events.length) return res.status(400).json({ ok: false, error: "aucun événement" });

    const db = admin.firestore();
    const now = admin.firestore.FieldValue.serverTimestamp();
    let n = 0; // les événements d'un même envoi sont dans l'ordre chronologique (le dernier gagne)
    for (let i = 0; i < events.length; i += 200) {
      const batch = db.batch();
      for (const e of events.slice(i, i + 200)) {
        const uid = str(e.uid, 80).replace(/[^A-Za-z0-9_.-]/g, "_");
        if (!uid) continue;
        const ref = str(e.reference, 32).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
        const r = e.resultat && typeof e.resultat === "object" ? e.resultat : null;
        const ev = {
          source: str(e.source, 20), date: str(e.date, 25), day: str(e.date, 10),
          id_order: Number(e.id_order) || null, reference: ref, action: str(e.action, 30), ok: e.ok === true,
          operateur: str(e.operateur, 120), message: str(e.message, 2000),
          resultat: r && JSON.stringify(r).length <= 20000 ? r : null,
          pdv_commande: str(e.pdv_commande, 32), pdv_facture: str(e.pdv_facture, 32),
          pdv_avoirs: Array.isArray(e.pdv_avoirs) ? e.pdv_avoirs.slice(0, 20).map((x) => str(x, 32)) : [],
          received_at: now,
        };
        batch.set(db.collection("facturation_events").doc(uid), ev);
        n++;
        if (ref && e.action !== "test") {
          // une erreur n'efface jamais un état « facturée/capturée » : elle est signalée à part (last_ok=false)
          let st = ev.ok ? (STATUT[ev.action] || null) : null;
          if (st && r && r.statut === "simulation") st = null;
          if (st && r && r.payzen && typeof r.payzen === "object" && !r.payzen_erreur) st = "capturee";
          const o = { reference: ref, id_order: ev.id_order, last_date: ev.date, last_action: ev.action, last_ok: ev.ok,
            last_message: ev.ok ? "" : ev.message, updated_at: now };
          if (st) o.statut = st;
          if (ev.pdv_commande) o.pdv_commande = ev.pdv_commande;
          if (ev.pdv_facture) o.pdv_facture = ev.pdv_facture;
          if (ev.pdv_avoirs.length) o.pdv_avoirs = ev.pdv_avoirs;
          if (r && r.total_initial_ttc != null && ev.ok && st) o.total_initial_ttc = Number(r.total_initial_ttc);
          if (r && r.net_ttc != null && ev.ok && st) o.net_ttc = Number(r.net_ttc);
          if (r && Array.isArray(r.modifications) && ev.ok && st) o.modifications = r.modifications.slice(0, 50).map((x) => str(x, 300));
          if (!ev.ok) o.nb_erreurs = admin.firestore.FieldValue.increment(1);
          if (ev.ok && /_sim$/.test(ev.action) && r && r.net_ttc != null) o.simulation_net_ttc = Number(r.net_ttc);
          batch.set(db.collection("facturation_orders").doc(ref), o, { merge: true });
        }
      }
      await batch.commit();
    }
    return res.json({ ok: true, n });
  }
);


// ---------------------------------------------------------------------------------------------
// kbgFacturerWeb — appelée par l'appli (Master / clôture distrib) pour UNE commande web :
//   facture PDV + avoir des écarts + site au montant réel + PayZen (si activé), via le module.
// Le secret ne quitte jamais le serveur ; seuls master (admin) et équipes distrib/prépa connectées.
// ---------------------------------------------------------------------------------------------
const MODULE_API = "https://www.kelbongoo.com.livesaas.fr/index.php?fc=module&module=kbfacturation&controller=api";

exports.kbgFacturerWeb = onCall(
  { region: "europe-west1", secrets: [FACTU_LOG_SECRET], maxInstances: 4, timeoutSeconds: 120 },
  async (request) => {
    const t = (request.auth && request.auth.token) || {};
    if (!(t.admin === true || ["distrib", "prep"].includes(t.kbRole))) throw new HttpsError("permission-denied", "Réservé à l'équipe Kelbongoo connectée");
    const d = request.data || {};
    const reference = String(d.reference || "").toUpperCase();
    if (!/^[A-Z0-9]{5,16}$/.test(reference)) throw new HttpsError("invalid-argument", "Référence de commande invalide");
    const ecarts = (Array.isArray(d.ecarts) ? d.ecarts : []).slice(0, 200).map((e) => ({
      ean: str(e.ean, 20), produit: str(e.produit, 200),
      manque: Math.max(0, parseInt(e.manque, 10) || 0),
      remise_pct: Math.max(0, Math.min(100, Number(e.remise_pct) || 0)),
      remise_qte: Math.max(0, parseInt(e.remise_qte, 10) || 0),
    }));
    if (!d.dry_run && t.admin !== true && t.kbRole !== "distrib") throw new HttpsError("permission-denied", "Facturation réelle : master ou distrib uniquement");
    const payload = { action: "facturer", reference, ecarts, dry_run: !!d.dry_run, ts: Math.floor(Date.now() / 1000),
      by: str(t.kbName || t.email || request.auth.uid, 80) };
    if (d.bcc) payload.bcc = str(d.bcc, 32);
    const body = JSON.stringify(payload);
    const sig = crypto.createHmac("sha256", FACTU_LOG_SECRET.value()).update(body).digest("hex");
    let r, j;
    try {
      r = await fetch(MODULE_API, { method: "POST", headers: { "Content-Type": "application/json", "X-KBG-Signature": sig }, body });
      j = await r.json();
    } catch (e) {
      throw new HttpsError("unavailable", "Site injoignable : " + String(e.message || e));
    }
    return { ok: !!(j && j.ok), http: r.status, resultat: (j && j.resultat) || null, erreur: (j && j.erreur) || null };
  }
);
