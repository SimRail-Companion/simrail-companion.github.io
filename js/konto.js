/*
  SimRail Companion – Konto & Burger-Menü
  ======================================
  Eingebunden im <head> von index.html und app.html – NACH der
  Supabase-Bibliothek und VOR allen anderen Skripten.

  - Gast: Alles bleibt im Browser (localStorage, Einträge "simrail_...").
  - Konto (Supabase, E-Mail + Passwort): Jede Änderung an einem
    "simrail_..."-Eintrag geht an die Tabelle "fortschritt" (siehe
    supabase/einrichtung.sql). Beim Öffnen holt die Seite den neuesten Stand.
    So hat jeder Spieler seinen eigenen Fortschritt – auf jedem Gerät.
  - Beim Anmelden wird der Gast-Stand beiseitegelegt und beim Abmelden
    zurückgeholt. Ein neues, leeres Konto übernimmt den Gast-Stand.

  Die App selbst liest und schreibt localStorage wie gewohnt.
*/
(function () {
  "use strict";

  // Öffentliche Zugangsdaten des Supabase-Projekts (dürfen in der Webseite stehen;
  // geschützt wird über die Zeilen-Regeln in der Datenbank)
  const SUPABASE_URL = "https://tueizogtxtdwlhbfhmyb.supabase.co";
  const SUPABASE_KEY = "sb_publishable_fji9RzwRsJU-g13UpPRh5g_fTQymmai";

  const GERAET = new Set(["simrail_seite", "simrail_gast_sicherung", "simrail_ansage_an"]);   // gehören zum Gerät, nicht zum Spieler
  const K = { id: "simrail_konto_id", name: "simrail_konto_name", version: "simrail_konto_version",
              offen: "simrail_konto_offen" };
  const PUSH_VERZOEGERUNG_MS = 1500;
  const NEU_LADEN_FENSTER_MS = 5000;

  const ls = window.localStorage;
  const roh = { get: Storage.prototype.getItem, set: Storage.prototype.setItem,
                del: Storage.prototype.removeItem, key: Storage.prototype.key };
  const geladenUm = Date.now();
  let intern = false, pushTimer = null, syncZustand = "", laeuftHoch = null;
  let reiter = "anmelden", meldung = "", passwortNeu = false;
  let panel, schleier, knopf;

  const sb = window.supabase && window.supabase.createClient
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY,
        { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
    : null;

  // ---------- Grundlagen ----------

  function wirdGespeichert(k) {
    return typeof k === "string" && k.indexOf("simrail_") === 0 &&
           k.indexOf("simrail_konto_") !== 0 && !GERAET.has(k);
  }
  function spielerSchluessel() {
    const liste = [];
    for (let i = 0; i < ls.length; i++) {
      const k = roh.key.call(ls, i);
      if (wirdGespeichert(k)) liste.push(k);
    }
    return liste;
  }
  const kontoId = () => roh.get.call(ls, K.id) || "";
  const kontoName = () => roh.get.call(ls, K.name) || "";
  const angemeldet = () => !!kontoId();
  const lokaleVersion = () => Number(roh.get.call(ls, K.version)) || 0;
  function offen() { try { return JSON.parse(roh.get.call(ls, K.offen) || "[]"); } catch (e) { return []; } }
  function offenSetzen(l) { if (l.length) roh.set.call(ls, K.offen, JSON.stringify(l)); else roh.del.call(ls, K.offen); }
  function setzeIntern(k, w) {
    intern = true;
    try { if (w === null || w === undefined) ls.removeItem(k); else ls.setItem(k, w); }
    finally { intern = false; }
  }
  function fehlerText(e) {
    const t = String((e && (e.message || e.error_description)) || e || "");
    if (/Invalid login credentials/i.test(t)) return "E-Mail oder Passwort stimmt nicht.";
    if (/Email not confirmed/i.test(t)) return "Bitte bestätige zuerst deine E-Mail-Adresse (Link in der Mail).";
    if (/already registered|already been registered/i.test(t)) return "Mit dieser E-Mail gibt es schon ein Konto.";
    if (/Password should be at least/i.test(t)) return "Das Passwort ist zu kurz (mindestens 8 Zeichen).";
    if (/rate limit|too many/i.test(t)) return "Zu viele Versuche – bitte später noch einmal.";
    if (/Failed to fetch|NetworkError/i.test(t)) return "Keine Verbindung zum Server – bist du online?";
    return t || "Unbekannter Fehler.";
  }

  // ---------- Fortschritt: Änderungen mitschreiben und hochladen ----------

  function vermerken(k) {
    if (intern || !angemeldet() || !wirdGespeichert(k)) return;
    const l = offen();
    if (l.indexOf(k) < 0) { l.push(k); offenSetzen(l); }
    zustand("speichert");
    clearTimeout(pushTimer);
    pushTimer = setTimeout(hochladen, PUSH_VERZOEGERUNG_MS);
  }
  Storage.prototype.setItem = function (k, w) { roh.set.call(this, k, w); if (this === ls) vermerken(String(k)); };
  Storage.prototype.removeItem = function (k) { roh.del.call(this, k); if (this === ls) vermerken(String(k)); };

  async function hochladen() {
    if (!angemeldet() || !sb) return;
    if (laeuftHoch) await laeuftHoch;
    const l = offen();
    if (!l.length) { zustand("gespeichert"); return; }
    const aenderungen = {};
    for (const k of l) aenderungen[k] = roh.get.call(ls, k);
    laeuftHoch = (async () => {
      try {
        const vorher = lokaleVersion();
        const { data, error } = await sb.rpc("fortschritt_aendern", { aenderungen, ersetzen: false });
        if (error) throw error;
        offenSetzen(offen().filter(k => roh.get.call(ls, k) !== aenderungen[k]));
        roh.set.call(ls, K.version, String(data));
        zustand(offen().length ? "speichert" : "gespeichert");
        if (data !== vorher + 1) await abgleichen(false);     // ein anderes Gerät hat zwischendurch gespeichert
      } catch (e) {
        zustand("offline");
      } finally {
        laeuftHoch = null;
      }
    })();
    return laeuftHoch;
  }

  async function standHolen() {
    const { data, error } = await sb.from("fortschritt").select("daten, version").maybeSingle();
    if (error) throw error;
    return data || { daten: {}, version: 0 };
  }

  // Stand vom Server übernehmen; eigene, noch nicht hochgeladene Änderungen gewinnen
  function standAnwenden(stand) {
    const ungesichert = new Set(offen());
    const daten = stand.daten || {};
    let geaendert = false;
    for (const k of spielerSchluessel()) {
      if (!(k in daten) && !ungesichert.has(k)) { setzeIntern(k, null); geaendert = true; }
    }
    for (const k in daten) {
      if (!wirdGespeichert(k) || ungesichert.has(k)) continue;
      if (roh.get.call(ls, k) !== daten[k]) { setzeIntern(k, daten[k]); geaendert = true; }
    }
    roh.set.call(ls, K.version, String(stand.version || 0));
    return geaendert;
  }

  async function abgleichen(beimStart) {
    if (!angemeldet() || !sb) return;
    try {
      if (offen().length) await hochladen();
      const stand = await standHolen();
      if (stand.version !== lokaleVersion() && standAnwenden(stand)) {
        if (beimStart && Date.now() - geladenUm < NEU_LADEN_FENSTER_MS) location.reload();
        else hinweisNeuLaden();
      }
      zustand("gespeichert");
    } catch (e) {
      zustand("offline");
    }
  }

  // ---------- Anmelden / Registrieren / Abmelden ----------

  function gastSichern() {
    if (roh.get.call(ls, "simrail_gast_sicherung") !== null) return;
    const daten = {};
    for (const k of spielerSchluessel()) daten[k] = roh.get.call(ls, k);
    if (Object.keys(daten).length) roh.set.call(ls, "simrail_gast_sicherung", JSON.stringify(daten));
  }
  function gastZurueck() {
    for (const k of spielerSchluessel()) setzeIntern(k, null);
    let daten = {};
    try { daten = JSON.parse(roh.get.call(ls, "simrail_gast_sicherung") || "{}"); } catch (e) {}
    for (const k in daten) if (wirdGespeichert(k)) setzeIntern(k, daten[k]);
    roh.del.call(ls, "simrail_gast_sicherung");
  }

  // Nach erfolgreicher Anmeldung (auch nach Klick auf den Bestätigungslink)
  async function nachAnmeldung(user) {
    const vorige = kontoId();
    if (vorige === user.id) return;                       // war schon angemeldet
    const name = (user.user_metadata && user.user_metadata.spielername) || user.email || "Spieler";
    if (vorige) {
      for (const k of spielerSchluessel()) setzeIntern(k, null);   // Reste eines anderen Kontos
    } else {
      gastSichern();
    }
    roh.set.call(ls, K.id, user.id);
    roh.set.call(ls, K.name, name);
    offenSetzen([]);
    roh.set.call(ls, K.version, "0");
    const stand = await standHolen();
    if (!stand.version && !vorige) {
      // Neues, leeres Konto: den bisherigen Gast-Fortschritt mitnehmen
      const daten = {};
      for (const k of spielerSchluessel()) daten[k] = roh.get.call(ls, k);
      if (Object.keys(daten).length) {
        const { data, error } = await sb.rpc("fortschritt_aendern", { aenderungen: daten, ersetzen: true });
        if (error) throw error;
        roh.set.call(ls, K.version, String(data));
      }
    } else {
      standAnwenden(stand);
    }
    location.reload();                                    // die App liest ihren Stand beim Start
  }

  async function anmelden(email, passwort) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password: passwort });
    if (error) throw error;
    await nachAnmeldung(data.user);
  }

  async function registrieren(spielername, email, passwort) {
    const { data, error } = await sb.auth.signUp({
      email, password: passwort,
      options: { data: { spielername }, emailRedirectTo: location.origin + location.pathname }
    });
    if (error) throw error;
    if (data.session && data.user) { await nachAnmeldung(data.user); return; }
    meldung = "✉️ Fast geschafft: Wir haben dir eine E-Mail an " + email + " geschickt. " +
              "Klick auf den Link darin – danach bist du angemeldet.";
    reiter = "anmelden";
    zeichnen();
  }

  async function passwortVergessen(email) {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) throw error;
    meldung = "✉️ Wenn es zu " + email + " ein Konto gibt, kommt gleich eine E-Mail mit einem Link zum neuen Passwort.";
    reiter = "anmelden";
    zeichnen();
  }

  async function abmelden() {
    if (angemeldet()) {
      try { await hochladen(); } catch (e) {}
      if (offen().length && !confirm("Einige Änderungen konnten nicht gespeichert werden (keine Verbindung). " +
                                     "Trotzdem abmelden? Sie gehen dann verloren.")) return;
      try { await sb.auth.signOut(); } catch (e) {}
    }
    for (const k of Object.values(K)) roh.del.call(ls, k);
    gastZurueck();
    location.reload();
  }

  // ---------- Oberfläche ----------

  const CSS = `
  #kt-knopf { position: fixed; top: 12px; right: 12px; z-index: 9000; width: 44px; height: 44px; margin: 0; padding: 0;
    border: 1px solid #3a3f4b; border-radius: 10px; background: #252932cc; backdrop-filter: blur(6px); color: #e8e8e8;
    cursor: pointer; display: grid; place-items: center; }
  #kt-knopf:hover { background: #333947; }
  #kt-knopf span, #kt-knopf span::before, #kt-knopf span::after { display: block; width: 20px; height: 2px;
    background: currentColor; border-radius: 2px; position: relative; content: ""; }
  #kt-knopf span::before { position: absolute; top: -6px; } #kt-knopf span::after { position: absolute; top: 6px; }
  #kt-knopf .kt-punkt { position: absolute; top: 7px; right: 7px; width: 9px; height: 9px; border-radius: 50%;
    background: #3fb950; border: 2px solid #1a1d24; }
  #kt-knopf .kt-punkt.aus { display: none; }
  #kt-schleier { position: fixed; inset: 0; background: #0008; z-index: 9001; opacity: 0; pointer-events: none; transition: opacity .2s; }
  #kt-schleier.offen { opacity: 1; pointer-events: auto; }
  #kt-panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(360px, 100vw); z-index: 9002; background: #1f232b;
    border-left: 1px solid #3a3f4b; color: #e8e8e8; overflow-y: auto; transform: translateX(100%); transition: transform .22s ease;
    font: 15px system-ui, -apple-system, "Segoe UI", Arial, sans-serif; box-sizing: border-box; padding: 18px 20px 28px; }
  #kt-panel.offen { transform: none; }
  #kt-panel * { box-sizing: border-box; }
  #kt-panel .kt-kopf { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  #kt-panel .kt-titel { font-weight: bold; color: #4da3ff; font-size: 17px; }
  #kt-panel .kt-zu { margin: 0; padding: 4px 10px; background: transparent; color: #9aa0aa; border: none; font-size: 24px; cursor: pointer; }
  #kt-panel nav a { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 8px; color: #e8e8e8; text-decoration: none; }
  #kt-panel nav a:hover { background: #2b303a; }
  #kt-panel nav a.aktiv { background: #4da3ff22; color: #8fc7ff; }
  #kt-panel h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #9aa0aa; margin: 22px 0 8px; font-weight: normal; }
  #kt-panel .kt-karte { background: #252932; border: 1px solid #333947; border-radius: 10px; padding: 14px; }
  #kt-panel .kt-reiter { display: flex; gap: 4px; background: #1a1d24; border-radius: 8px; padding: 3px; margin-bottom: 12px; }
  #kt-panel .kt-reiter button { flex: 1; margin: 0; padding: 7px; border: none; border-radius: 6px; background: transparent;
    color: #c7ccd4; font-weight: normal; cursor: pointer; font-size: 14px; }
  #kt-panel .kt-reiter button.aktiv { background: #4da3ff; color: #0b0e14; font-weight: bold; }
  #kt-panel label { display: block; margin: 10px 0 4px; font-size: 13px; color: #c7ccd4; }
  #kt-panel input { width: 100%; padding: 9px; margin: 0; border: 1px solid #3a3f4b; border-radius: 6px; background: #1a1d24; color: #e8e8e8; font-size: 15px; }
  #kt-panel .kt-los { width: 100%; margin: 14px 0 0; padding: 10px; border: none; border-radius: 6px; background: #4da3ff;
    color: #0b0e14; font-weight: bold; cursor: pointer; font-size: 15px; }
  #kt-panel .kt-los.grau { background: #3a3f4b; color: #e8e8e8; font-weight: normal; }
  #kt-panel .kt-link { background: none; border: none; color: #8fc7ff; padding: 0; margin: 10px 0 0; cursor: pointer; font-size: 13px; text-decoration: underline; }
  #kt-panel .kt-fehler { color: #ff8a80; font-size: 13px; margin-top: 10px; min-height: 1em; }
  #kt-panel .kt-meldung { color: #7fe0a0; font-size: 13px; margin: 0 0 10px; line-height: 1.45; }
  #kt-panel .kt-klein { color: #9aa0aa; font-size: 12.5px; line-height: 1.45; margin-top: 10px; }
  #kt-panel .kt-wer { display: flex; gap: 12px; align-items: center; }
  #kt-panel .kt-bild { width: 42px; height: 42px; border-radius: 50%; background: #4da3ff; color: #0b0e14; display: grid;
    place-items: center; font-weight: bold; font-size: 18px; flex: none; }
  #kt-panel .kt-sync { font-size: 12.5px; color: #9aa0aa; } #kt-panel .kt-sync.ok { color: #3fb950; } #kt-panel .kt-sync.warn { color: #ffb454; }
  #kt-hinweis { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 9003; background: #252932;
    border: 1px solid #4da3ff; color: #e8e8e8; padding: 10px 14px; border-radius: 10px; font: 14px system-ui, sans-serif;
    display: flex; gap: 12px; align-items: center; max-width: calc(100vw - 32px); }
  #kt-hinweis button { margin: 0; padding: 6px 12px; border: none; border-radius: 6px; background: #4da3ff; color: #0b0e14; font-weight: bold; cursor: pointer; }
  `;

  function esc(t) {
    return String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function hier() { return /app(\.html)?$/.test(location.pathname) ? "app" : "start"; }

  function syncText() {
    return { speichert: ["Wird gespeichert …", ""], gespeichert: ["✓ Fortschritt gespeichert", "ok"],
             offline: ["Keine Verbindung – wird nachgeholt", "warn"] }[syncZustand] || ["", ""];
  }
  function zustand(z) {
    syncZustand = z;
    const el = panel && panel.querySelector("#kt-sync");
    if (el) { const [t, k] = syncText(); el.textContent = t; el.className = "kt-sync " + k; }
  }

  function aufbauen() {
    const stil = document.createElement("style");
    stil.textContent = CSS;
    document.head.appendChild(stil);
    knopf = document.createElement("button");
    knopf.id = "kt-knopf"; knopf.type = "button";
    knopf.setAttribute("aria-label", "Menü öffnen"); knopf.setAttribute("aria-expanded", "false");
    knopf.setAttribute("aria-controls", "kt-panel");
    knopf.innerHTML = '<span></span><i class="kt-punkt aus"></i>';
    knopf.addEventListener("click", () => oeffnen());
    schleier = document.createElement("div");
    schleier.id = "kt-schleier";
    schleier.addEventListener("click", schliessen);
    panel = document.createElement("aside");
    panel.id = "kt-panel";
    panel.setAttribute("aria-label", "Menü und Konto"); panel.setAttribute("aria-hidden", "true");
    panel.inert = true;
    document.body.append(schleier, panel, knopf);
    document.addEventListener("keydown", e => { if (e.key === "Escape") schliessen(); });
    zeichnen();
  }

  function zeichnen() {
    if (!panel) return;
    const nav = "<nav>" + [["start", "index.html", "🏠", "Startseite"], ["app", "app.html", "🚂", "Zur App"]]
      .map(([z, href, s, t]) => '<a href="' + href + '"' + (hier() === z ? ' class="aktiv" aria-current="page"' : "") +
           "><span>" + s + "</span>" + t + "</a>").join("") + "</nav>";
    let inhalt;
    if (!sb) {
      inhalt = '<div class="kt-karte"><p class="kt-klein" style="margin:0">Die Anmeldung ist gerade nicht erreichbar. ' +
               "Du kannst als Gast weiterspielen – dein Fortschritt bleibt in diesem Browser.</p></div>";
    } else if (passwortNeu) {
      inhalt = '<div class="kt-karte"><form id="kt-neu"><label for="kt-pw-neu">Neues Passwort</label>' +
        '<input type="password" id="kt-pw-neu" autocomplete="new-password" minlength="8" required>' +
        '<button class="kt-los" type="submit">Passwort speichern</button><div class="kt-fehler" id="kt-fehler" role="alert"></div></form></div>';
    } else if (angemeldet()) {
      const [t, k] = syncText();
      inhalt = '<div class="kt-karte"><div class="kt-wer"><div class="kt-bild">' + esc(kontoName().charAt(0).toUpperCase()) +
        '</div><div><div><b>' + esc(kontoName()) + '</b></div><div class="kt-sync ' + k + '" id="kt-sync">' + esc(t) + "</div></div></div>" +
        '<button class="kt-los grau" type="button" id="kt-ab">Abmelden</button></div>' +
        '<p class="kt-klein">Dein Fortschritt wird bei jeder Änderung gespeichert. Auf einem anderen Gerät einfach ' +
        "mit derselben E-Mail anmelden.</p>";
    } else {
      const r = reiter;
      inhalt = '<div class="kt-karte">' + (meldung ? '<p class="kt-meldung">' + esc(meldung) + "</p>" : "") +
        (r !== "vergessen" ? '<div class="kt-reiter" role="tablist">' +
          '<button type="button" role="tab" aria-selected="' + (r === "anmelden") + '" class="' + (r === "anmelden" ? "aktiv" : "") +
          '" data-reiter="anmelden">Anmelden</button><button type="button" role="tab" aria-selected="' + (r === "registrieren") +
          '" class="' + (r === "registrieren" ? "aktiv" : "") + '" data-reiter="registrieren">Registrieren</button></div>' : "") +
        '<form id="kt-form">' +
        (r === "registrieren" ? '<label for="kt-spieler">Spielername</label><input type="text" id="kt-spieler" ' +
          'autocomplete="nickname" required minlength="2" maxlength="24">' : "") +
        '<label for="kt-email">E-Mail</label><input type="email" id="kt-email" autocomplete="email" required>' +
        (r !== "vergessen" ? '<label for="kt-pw1">Passwort</label><input type="password" id="kt-pw1" required ' +
          (r === "registrieren" ? 'minlength="8" autocomplete="new-password"' : 'autocomplete="current-password"') + ">" : "") +
        (r === "registrieren" ? '<label for="kt-pw2">Passwort wiederholen</label><input type="password" id="kt-pw2" ' +
          'autocomplete="new-password" required minlength="8">' : "") +
        '<button class="kt-los" type="submit">' + ({ anmelden: "Anmelden", registrieren: "Konto anlegen",
          vergessen: "Link zum neuen Passwort schicken" }[r]) + "</button>" +
        '<div class="kt-fehler" id="kt-fehler" role="alert"></div></form>' +
        (r === "anmelden" ? '<button type="button" class="kt-link" data-reiter="vergessen">Passwort vergessen?</button>' : "") +
        (r === "vergessen" ? '<button type="button" class="kt-link" data-reiter="anmelden">‹ zurück zur Anmeldung</button>' : "") +
        '<p class="kt-klein">' + (r === "registrieren"
          ? "Passwort: mindestens 8 Zeichen. Nach dem Anlegen bekommst du eine E-Mail zur Bestätigung. " +
            "Dein bisheriger Fortschritt aus diesem Browser kommt automatisch ins neue Konto."
          : "Ohne Konto spielst du als Gast – der Fortschritt bleibt dann nur in diesem Browser.") + "</p></div>";
    }
    panel.innerHTML = '<div class="kt-kopf"><span class="kt-titel">🚂 SimRail Companion</span>' +
      '<button class="kt-zu" type="button" aria-label="Menü schließen">×</button></div>' + nav + "<h3>Konto</h3>" + inhalt;
    panel.querySelector(".kt-zu").addEventListener("click", schliessen);
    for (const b of panel.querySelectorAll("[data-reiter]")) {
      b.addEventListener("click", () => { reiter = b.dataset.reiter; meldung = ""; zeichnen(); fokus(); });
    }
    const form = panel.querySelector("#kt-form");
    if (form) form.addEventListener("submit", absenden);
    const neu = panel.querySelector("#kt-neu");
    if (neu) neu.addEventListener("submit", passwortSetzen);
    const ab = panel.querySelector("#kt-ab");
    if (ab) ab.addEventListener("click", abmelden);
    knopf.querySelector(".kt-punkt").classList.toggle("aus", !angemeldet());
    knopf.title = angemeldet() ? "Angemeldet als " + kontoName() : "Menü – nicht angemeldet";
  }

  async function absenden(e) {
    e.preventDefault();
    const f = panel.querySelector("#kt-fehler");
    const los = panel.querySelector("#kt-form .kt-los");
    const wert = id => (panel.querySelector(id) || {}).value || "";
    f.textContent = "";
    if (reiter === "registrieren" && wert("#kt-pw1") !== wert("#kt-pw2")) {
      f.textContent = "Die beiden Passwörter sind nicht gleich.";
      return;
    }
    const text = los.textContent;
    los.disabled = true; los.textContent = "Einen Moment …";
    try {
      if (reiter === "registrieren") await registrieren(wert("#kt-spieler").trim(), wert("#kt-email").trim(), wert("#kt-pw1"));
      else if (reiter === "vergessen") await passwortVergessen(wert("#kt-email").trim());
      else await anmelden(wert("#kt-email").trim(), wert("#kt-pw1"));
    } catch (x) {
      const f2 = panel.querySelector("#kt-fehler");
      if (f2) f2.textContent = fehlerText(x);
      const l2 = panel.querySelector("#kt-form .kt-los");
      if (l2) { l2.disabled = false; l2.textContent = text; }
    }
  }

  async function passwortSetzen(e) {
    e.preventDefault();
    const f = panel.querySelector("#kt-fehler");
    try {
      const { error } = await sb.auth.updateUser({ password: panel.querySelector("#kt-pw-neu").value });
      if (error) throw error;
      passwortNeu = false;
      meldung = "✓ Neues Passwort gespeichert.";
      zeichnen();
    } catch (x) {
      f.textContent = fehlerText(x);
    }
  }

  function fokus() {
    const feld = panel.querySelector("#kt-spieler") || panel.querySelector("#kt-email") || panel.querySelector(".kt-zu");
    if (feld) setTimeout(() => feld.focus(), 60);
  }
  function oeffnen(neuerReiter) {
    if (!panel) return;
    if (neuerReiter && !angemeldet()) { reiter = neuerReiter; meldung = ""; zeichnen(); }
    panel.classList.add("offen"); schleier.classList.add("offen");
    panel.setAttribute("aria-hidden", "false"); panel.inert = false;
    knopf.setAttribute("aria-expanded", "true");
    if (!angemeldet()) fokus(); else panel.querySelector(".kt-zu").focus();
  }
  function schliessen() {
    if (!panel || !panel.classList.contains("offen")) return;
    panel.classList.remove("offen"); schleier.classList.remove("offen");
    panel.setAttribute("aria-hidden", "true"); panel.inert = true;
    knopf.setAttribute("aria-expanded", "false"); knopf.focus();
  }
  function hinweisNeuLaden() {
    if (document.getElementById("kt-hinweis")) return;
    const h = document.createElement("div");
    h.id = "kt-hinweis"; h.setAttribute("role", "status");
    h.innerHTML = "<span>Neuer Spielstand von einem anderen Gerät.</span>";
    const b = document.createElement("button");
    b.textContent = "Neu laden"; b.addEventListener("click", () => location.reload());
    h.appendChild(b); document.body.appendChild(h);
  }
  function bescheidGeben() {
    zeichnen();
    document.dispatchEvent(new CustomEvent("simrailkonto", { detail: { angemeldet: angemeldet(), name: kontoName() } }));
  }

  // ---------- Start ----------

  window.SimRailKonto = { angemeldet, name: kontoName, oeffnen, schliessen, abmelden };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { aufbauen(); bescheidGeben(); });
  else aufbauen();

  if (sb) {
    sb.auth.onAuthStateChange(function (ereignis, sitzung) {
      if (ereignis === "PASSWORD_RECOVERY") {
        passwortNeu = true;
        setTimeout(() => { zeichnen(); oeffnen(); }, 0);
      } else if (ereignis === "SIGNED_IN" && sitzung && sitzung.user && sitzung.user.id !== kontoId()) {
        // z. B. nach Klick auf den Bestätigungslink in der E-Mail
        setTimeout(() => nachAnmeldung(sitzung.user).catch(() => {}), 0);
      } else if (ereignis === "SIGNED_OUT" && angemeldet()) {
        // Sitzung abgelaufen oder auf einem anderen Weg abgemeldet: Name und Daten bleiben bis zum Neuanmelden
        zustand("offline");
      }
    });
    if (angemeldet()) {
      abgleichen(true);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") abgleichen(false); });
      window.addEventListener("pagehide", () => { if (offen().length) hochladen(); });
    }
  }
})();
