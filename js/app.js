/*
  SimRail Companion – App (Version 1: klassischer Dienstplan)
  ==========================================================
  Der Dienstplan kettet Zugfahrten zwischen Border Stations aneinander:
  Jede Fahrt beginnt dort, wo die vorige endete – im gewählten Zeitfenster.
  Grundlage ist der Fahrplan in daten/trains.js (Liste TRAINS).

  Gespeichert wird alles im localStorage ("simrail_..."-Einträge). Ist man
  angemeldet, schickt js/konto.js jede Änderung automatisch ans Konto.
*/
"use strict";

/* ---------------- Kleine Helfer ---------------- */

function zuMinuten(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function zuUhrzeit(minuten) {
  const m = ((minuten % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}
function sicher(x) {
  return String(x === null || x === undefined ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function zahl(x, stellen) {
  return (Number(x) || 0).toLocaleString("de-DE", { maximumFractionDigits: stellen ?? 1 });
}
function gattung(zug) {
  return String((zug && zug.name) || "").split(" - ")[0].trim();
}
function lesen(schluessel, standard) {
  try { const w = JSON.parse(localStorage.getItem(schluessel)); return w ?? standard; } catch (e) { return standard; }
}
function schreiben(schluessel, wert) {
  if (wert === null || wert === undefined) localStorage.removeItem(schluessel);
  else localStorage.setItem(schluessel, JSON.stringify(wert));
}

/* ---------------- Fahrplandaten ---------------- */

const FAHRBARE_ZUEGE = TRAINS.filter(z => z.drv === 1);
const ZUG_NACH_NUMMER = new Map(FAHRBARE_ZUEGE.map(z => [String(z.no), z]));
const fahrtSchluessel = (nr, abschnitt) => nr + "#" + abschnitt;

// Border Stations, an denen ein Dienst beginnen kann
const START_BAHNHOEFE = (function () {
  const namen = new Set();
  for (const zug of FAHRBARE_ZUEGE)
    for (const seq of zug.segs)
      for (let i = 0; i < seq.length - 1; i++) namen.add(seq[i].st);
  return [...namen].sort((a, b) => a.localeCompare(b, "pl"));
})();

/* ---------------- Gespeicherter Stand ---------------- */

let fahrten = lesen("simrail_fahrten", []);                    // alle gefahrenen Fahrten
let gefahrene = new Set(lesen("simrail_gefahren", []));         // ganz gefahrene Abschnitte (nicht mehr einplanen)
let plan = lesen("simrail_plan", null);                         // aktueller Dienstplan

function heimat() { return localStorage.getItem("simrail_home") || ""; }
function gesperrt() { return localStorage.getItem("simrail_startGesperrt") === "ja"; }

function fahrtenSpeichern() {
  schreiben("simrail_fahrten", fahrten);
  schreiben("simrail_gefahren", [...gefahrene]);
}

/* ---------------- Seiten ---------------- */

function seiteZeigen(name) {
  for (const s of document.querySelectorAll(".seite")) s.classList.toggle("aktiv", s.id === "seite-" + name);
  for (const k of document.querySelectorAll(".reiter button")) k.classList.toggle("aktiv", k.id === "nav-" + name);
  localStorage.setItem("simrail_seite", name);
  if (name === "dienstplan") jetztAlsStart();
  if (name === "fahrten") fahrtenZeichnen();
  window.scrollTo(0, 0);
}

/* ---------------- Dienstplan: Eingaben ---------------- */

function startbahnhoefeLaden() {
  const auswahl = document.getElementById("startBahnhof");
  auswahl.innerHTML = START_BAHNHOEFE.map(n => '<option value="' + sicher(n) + '">' + sicher(n) + "</option>").join("");
  if (heimat() && START_BAHNHOEFE.includes(heimat())) auswahl.value = heimat();
  auswahl.addEventListener("change", () => { localStorage.setItem("simrail_home", auswahl.value); homeAnzeigen(); });
  document.getElementById("startGesperrt").checked = gesperrt();
  sperreAnwenden();
  homeAnzeigen();
}

function homeAnzeigen() {
  document.getElementById("homeAnzeige").textContent = document.getElementById("startBahnhof").value || "–";
}

function sperreUmschalten(an) {
  localStorage.setItem("simrail_startGesperrt", an ? "ja" : "nein");
  sperreAnwenden();
}
function sperreAnwenden() {
  const an = gesperrt() && !!heimat();
  document.getElementById("startBahnhof").disabled = an;
  document.getElementById("zufallKnopf").disabled = an;
  if (an) document.getElementById("startBahnhof").value = heimat();
  homeAnzeigen();
}

function zufallsStart() {
  const auswahl = document.getElementById("startBahnhof");
  auswahl.value = START_BAHNHOEFE[Math.floor(Math.random() * START_BAHNHOEFE.length)];
  localStorage.setItem("simrail_home", auswahl.value);
  homeAnzeigen();
}

// Beim Oeffnen des Dienstplans: Beginn = jetzt, Ende = in 3 Stunden
function jetztAlsStart() {
  const jetzt = new Date();
  const min = jetzt.getHours() * 60 + jetzt.getMinutes();
  document.getElementById("fensterVon").value = zuUhrzeit(min);
  if (!document.getElementById("fensterBis").value) document.getElementById("fensterBis").value = zuUhrzeit(min + 180);
}

/* ---------------- Dienstplan: Generator ---------------- */

const PAUSE_MIN = 10;          // Mindestpause zwischen zwei Fahrten
const PLAN_VARIANTEN = 5;      // so viele Plaene zur Auswahl
let planAuswahl = [];

// Alle Fahrten, die man an der Border Station 'ort' ab 'zeit' uebernehmen kann -
// jede so weit wie moeglich (letzte Station im Zeitfenster)
function schrittFuer(fensterBis) {
  return function (ort, zeit, benutzt) {
    const liste = [];
    for (const zug of FAHRBARE_ZUEGE) {
      for (let a = 0; a < zug.segs.length; a++) {
        const seq = zug.segs[a];
        const schluessel = fahrtSchluessel(zug.no, a);
        if (benutzt.has(schluessel) || gefahrene.has(schluessel)) continue;
        for (let i = 0; i < seq.length - 1; i++) {
          if (seq[i].st !== ort) continue;
          let ab = zuMinuten(seq[i].dep);
          while (ab < zeit) ab += 1440;
          let ziel = null;
          for (let j = i + 1; j < seq.length; j++) {
            let dauer = zuMinuten(seq[j].arr) - zuMinuten(seq[i].dep);
            if (dauer < 0) dauer += 1440;              // ueber Mitternacht
            if (ab + dauer > fensterBis) break;
            ziel = { j, an: ab + dauer, km: Math.max(0, (seq[j].km ?? 0) - (seq[i].km ?? 0)) };
          }
          if (ziel) {
            liste.push({ eintrag: { schluessel, zugNr: String(zug.no), ab, an: ziel.an, von: ort,
                                    bis: seq[ziel.j].st, km: ziel.km, voll: i === 0 && ziel.j === seq.length - 1 },
                         ort: seq[ziel.j].st, zeit: ziel.an + PAUSE_MIN });
          }
          break;
        }
      }
    }
    return liste.sort((x, y) => x.eintrag.ab - y.eintrag.ab);
  };
}

// Mehrere Plaene: jeder beginnt mit einer anderen ersten Fahrt
function planVarianten(schritt, start, startZeit) {
  const plaene = [], gesehen = new Set();
  for (const kandidat of schritt(start, startZeit, new Set()).slice(0, 15)) {
    if (plaene.length >= PLAN_VARIANTEN) break;
    const fahrtenImPlan = [], benutzt = new Set();
    let k = kandidat;
    while (k && fahrtenImPlan.length < 30) {
      fahrtenImPlan.push(k.eintrag);
      benutzt.add(k.eintrag.schluessel);
      k = schritt(k.ort, k.zeit, benutzt)[0] || null;
    }
    const signatur = fahrtenImPlan.map(e => e.schluessel + "@" + e.ab).join("|");
    if (gesehen.has(signatur)) continue;
    gesehen.add(signatur);
    plaene.push(fahrtenImPlan);
  }
  return plaene;
}

function dienstplanGenerieren() {
  if (plan && plan.fahrten.some(e => !plan.erledigt[e.schluessel]) &&
      !confirm("Du hast noch einen offenen Dienstplan. Verwerfen und einen neuen erstellen?")) return;
  const start = document.getElementById("startBahnhof").value;
  const von = document.getElementById("fensterVon").value, bis = document.getElementById("fensterBis").value;
  if (!start || !von || !bis) { alert("Bitte Startbahnhof und Zeitfenster ausfüllen."); return; }
  localStorage.setItem("simrail_home", start);
  const fensterVon = zuMinuten(von);
  let fensterBis = zuMinuten(bis);
  if (fensterBis <= fensterVon) fensterBis += 1440;      // Ende am naechsten Tag
  planAuswahl = planVarianten(schrittFuer(fensterBis), start, fensterVon);
  plan = null;
  schreiben("simrail_plan", null);
  auswahlZeigen(start);
}

function auswahlZeigen(start) {
  const box = document.getElementById("dienstplanAusgabe");
  timerZeigen();
  if (!planAuswahl.length) {
    box.innerHTML = '<p class="warnung">Kein Zug gefunden, der ab ' + sicher(start) + " im gewählten Zeitfenster " +
      "zu einer weiteren Border Station fährt. Versuch ein größeres Fenster oder einen anderen Startbahnhof.</p>";
    return;
  }
  if (planAuswahl.length === 1) { planWaehlen(0); return; }
  const kmVon = p => p.reduce((s, e) => s + (e.km || 0), 0);
  const meisteKm = Math.max(...planAuswahl.map(kmVon));
  box.innerHTML = "<h3>🗂️ " + planAuswahl.length + " mögliche Dienstpläne</h3>" +
    '<p class="hinweis" style="margin-top:0">Jeder beginnt mit einer anderen ersten Fahrt – such dir einen aus.</p>' +
    planAuswahl.map((p, k) => {
      const erste = p[0], letzte = p[p.length - 1], dauer = letzte.an - erste.ab, km = kmVon(p);
      return '<div class="plan-wahl"><div class="plan-wahl-kopf"><span class="zeiten">' + String.fromCharCode(65 + k) +
        " · " + zuUhrzeit(erste.ab) + " – " + zuUhrzeit(letzte.an) +
        (km === meisteKm && km > 0 ? '<span class="plan-marke">meiste Strecke</span>' : "") + "</span>" +
        '<span class="eckdaten">' + p.length + (p.length === 1 ? " Fahrt" : " Fahrten") + " · " + Math.round(km) + " km · " +
        Math.floor(dauer / 60) + " Std " + (dauer % 60) + " Min</span></div>" +
        '<div class="plan-wahl-fahrten">' + p.map(e => zugMarke(e.zugNr) + sicher(e.von) + " → " + sicher(e.bis) +
          ' <span class="hinweis">' + zuUhrzeit(e.ab) + "–" + zuUhrzeit(e.an) + "</span>").join("<br>") + "</div>" +
        '<div class="plan-wahl-fuss"><span class="hinweis">Dienstende in <span class="home">' + sicher(letzte.bis) +
        '</span></span><button onclick="planWaehlen(' + k + ')">Diesen Plan nehmen</button></div></div>';
    }).join("");
}

function zugMarke(nr) {
  const zug = ZUG_NACH_NUMMER.get(String(nr));
  return '<span class="zugnr" title="' + sicher((zug && zug.name) || "") + '">' + sicher(gattung(zug)) + " " + sicher(nr) + "</span>";
}

function planWaehlen(k) {
  const heute = new Date(); heute.setHours(0, 0, 0, 0);
  plan = { fahrten: planAuswahl[k], erledigt: {}, tag: heute.getTime() };
  schreiben("simrail_plan", plan);
  planZeigen();
}

/* ---------------- Dienstplan: Anzeige und Abhaken ---------------- */

function planZeigen() {
  const box = document.getElementById("dienstplanAusgabe");
  timerZeigen();
  if (!plan || !plan.fahrten.length) { box.innerHTML = ""; return; }
  const letzte = plan.fahrten[plan.fahrten.length - 1];
  const fertig = plan.fahrten.every(e => plan.erledigt[e.schluessel]);
  let html = "<h3>🚆 Dein Dienstplan</h3>";
  for (const e of plan.fahrten) {
    const zug = ZUG_NACH_NUMMER.get(e.zugNr) || {};
    const erledigt = !!plan.erledigt[e.schluessel];
    html += '<div class="dienst-fahrt' + (erledigt ? " erledigt" : "") + '">' +
      '<div class="dienst-zeit">' + zuUhrzeit(e.ab) + "<br>" + zuUhrzeit(e.an) + "</div>" +
      '<div class="dienst-info"><div class="fahrt-strecke">' + zugMarke(e.zugNr) + sicher(e.von) + " → " + sicher(e.bis) + "</div>" +
      '<div class="fahrt-details">' + sicher(zug.name || "") + " · " + sicher(zug.loco || "–") + " · " +
        (zug.len || "?") + " m / " + (zug.wt || "?") + " t · " + zahl(e.km, 0) + " km</div></div>" +
      '<label class="haken"><input type="checkbox"' + (erledigt ? " checked" : "") +
        ' onchange="hakenSetzen(\'' + e.schluessel + '\', this.checked)"> gefahren</label></div>' +
      '<div id="abschluss-' + e.schluessel.replace("#", "_") + '"></div>';
  }
  html += fertig
    ? '<p class="hinweis">🏁 <b>Dienst geschafft!</b> Dein nächster Dienst beginnt in <span class="home">' +
      sicher(letzte.bis) + "</span>.</p>"
    : '<p class="hinweis">🏁 ' + plan.fahrten.length + (plan.fahrten.length === 1 ? " Fahrt" : " Fahrten") +
      " · Dienstende in <span class=\"home\">" + sicher(letzte.bis) + "</span></p>";
  html += '<button class="grau" onclick="planVerwerfen()">Dienstplan verwerfen</button>';
  box.innerHTML = html;
}

function hakenSetzen(schluessel, an) {
  const e = plan && plan.fahrten.find(x => x.schluessel === schluessel);
  if (!e) return;
  const platz = document.getElementById("abschluss-" + schluessel.replace("#", "_"));
  if (an) {
    // kleines Formular: gefahrene km (vorbelegt) und Verspaetung am Ziel
    platz.innerHTML = '<div class="abschluss"><b>Fahrt abschließen</b><div class="reihe">' +
      '<div><label>Kilometer</label><input type="number" min="0" step="0.1" id="ab-km" value="' + Math.round(e.km * 10) / 10 + '"></div>' +
      '<div><label>Verspätung am Ziel (min)</label><input type="number" step="1" id="ab-versp" placeholder="0 = pünktlich"></div></div>' +
      '<button onclick="fahrtAbschliessen(\'' + schluessel + '\')">Fahrt speichern</button> ' +
      '<button class="grau" onclick="planZeigen()">Abbrechen</button></div>';
    return;
  }
  // Haken weg: die gespeicherte Fahrt wieder entfernen
  const id = plan.erledigt[schluessel];
  fahrten = fahrten.filter(f => f.id !== id);
  if (e.voll) gefahrene.delete(schluessel);
  delete plan.erledigt[schluessel];
  fahrtenSpeichern();
  schreiben("simrail_plan", plan);
  planZeigen();
}

function fahrtAbschliessen(schluessel) {
  const e = plan.fahrten.find(x => x.schluessel === schluessel);
  const zug = ZUG_NACH_NUMMER.get(e.zugNr) || {};
  const versp = document.getElementById("ab-versp").value;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  fahrten.push({
    id, zug: schluessel, zugNr: e.zugNr, strecke: e.von + " → " + e.bis, von: e.von, bis: e.bis,
    kilometer: Number(document.getElementById("ab-km").value) || 0,
    verspaetung: versp === "" ? null : Number(versp),
    lok: zug.loco || "", gewicht: zug.wt || 0, laenge: zug.len || 0,
    datum: new Date().toLocaleDateString("de-DE"), zeit: Date.now()
  });
  if (e.voll) gefahrene.add(schluessel);
  plan.erledigt[schluessel] = id;
  fahrtenSpeichern();
  // Letzte Fahrt geschafft? Dann beginnt der naechste Dienst am Ziel
  if (plan.fahrten.every(x => plan.erledigt[x.schluessel])) {
    const ziel = plan.fahrten[plan.fahrten.length - 1].bis;
    if (START_BAHNHOEFE.includes(ziel)) {
      localStorage.setItem("simrail_home", ziel);
      document.getElementById("startBahnhof").value = ziel;
      sperreAnwenden();
    }
  }
  schreiben("simrail_plan", plan);
  planZeigen();
}

function planVerwerfen() {
  if (!confirm("Diesen Dienstplan verwerfen? Schon gefahrene Fahrten bleiben gespeichert.")) return;
  plan = null;
  schreiben("simrail_plan", null);
  planZeigen();
}

/* ---------------- Timer bis Dienstbeginn ---------------- */

let timerTakt = null;
function timerZeigen() {
  const box = document.getElementById("timer");
  clearInterval(timerTakt);
  if (!plan || !plan.fahrten.length || plan.fahrten.every(e => plan.erledigt[e.schluessel])) { box.innerHTML = ""; return; }
  const beginn = plan.tag + plan.fahrten[0].ab * 60000;
  const ende = plan.tag + plan.fahrten[plan.fahrten.length - 1].an * 60000;
  const tick = () => {
    const jetzt = Date.now();
    let text, unter;
    if (jetzt < beginn) {
      const s = Math.round((beginn - jetzt) / 1000);
      text = Math.floor(s / 3600) + ":" + String(Math.floor(s % 3600 / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
      unter = "bis Dienstbeginn um " + zuUhrzeit(plan.fahrten[0].ab) + " Uhr";
    } else if (jetzt < ende) {
      text = "Im Dienst"; unter = "Dienstende um " + zuUhrzeit(plan.fahrten[plan.fahrten.length - 1].an) + " Uhr";
    } else {
      text = "Dienstzeit vorbei"; unter = "Hak deine gefahrenen Fahrten ab";
    }
    box.innerHTML = '<div class="timer"><b>' + text + '</b><span class="hinweis">' + unter + "</span></div>";
  };
  tick();
  timerTakt = setInterval(tick, 1000);
}

/* ---------------- Fahrten ---------------- */

function fahrtenZeichnen() {
  const km = fahrten.reduce((s, f) => s + (Number(f.kilometer) || 0), 0);
  const mitVersp = fahrten.filter(f => f.verspaetung != null);
  document.getElementById("anzahlFahrten").textContent = fahrten.length;
  document.getElementById("gesamtKm").textContent = zahl(km, 0);
  document.getElementById("schnittVersp").textContent = mitVersp.length
    ? zahl(mitVersp.reduce((s, f) => s + f.verspaetung, 0) / mitVersp.length, 1) : "–";
  const liste = document.getElementById("fahrtenListe");
  liste.innerHTML = !fahrten.length
    ? '<p class="hinweis">Noch keine Fahrten – erstell dir einen Dienstplan und hak deine erste Fahrt ab.</p>'
    : fahrten.slice().reverse().map(f =>
        '<div class="fahrt"><div><div class="fahrt-strecke">' + (f.zugNr ? zugMarke(f.zugNr) : "") + sicher(f.strecke) + "</div>" +
        '<div class="fahrt-details">' + sicher(f.datum) + " · " +
          (f.verspaetung == null ? "Verspätung nicht eingetragen" : f.verspaetung > 0 ? "+" + f.verspaetung + " min" : "pünktlich") +
          (f.lok ? " · " + sicher(f.lok) : "") + "</div></div>" +
        '<div class="fahrt-details" style="white-space:nowrap">' + zahl(f.kilometer) + " km</div></div>").join("");
}

/* ---------------- Einstellungen ---------------- */

function karriereZuruecksetzen() {
  if (!confirm("Wirklich ALLE Fahrten, den Dienstplan und den Startbahnhof löschen?")) return;
  fahrten = []; gefahrene = new Set(); plan = null;
  for (const k of ["simrail_fahrten", "simrail_gefahren", "simrail_plan", "simrail_home", "simrail_startGesperrt"]) {
    localStorage.removeItem(k);
  }
  location.reload();
}

/* ---------------- Start ---------------- */

startbahnhoefeLaden();
planZeigen();
seiteZeigen(["dienstplan", "fahrten", "einstellungen"].includes(localStorage.getItem("simrail_seite"))
  ? localStorage.getItem("simrail_seite") : "dienstplan");
