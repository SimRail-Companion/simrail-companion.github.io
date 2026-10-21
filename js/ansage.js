/* SimRail Companion – Stationsansagen

   Etwa einen Kilometer vor jedem Halt sagt die App den Stationsnamen an –
   wie im echten Zug, auf Polnisch, Deutsch oder Englisch. Im Fernverkehr
   spricht stattdessen ein "Zugbegleiter": Begruessung nach der Abfahrt und
   Ansage einige Minuten vor der Ankunft.

   Woher die Daten kommen:
     - Position, Tempo und Fahrplanindex des eigenen Zuges: direkt aus den
       Live-Daten von SimRail (panel.simrail.eu). Der Browser holt ALLE Zuege
       des Servers und sucht sich den eigenen ueber die Steam-ID heraus – die
       Steam-ID verlaesst dabei nie den Browser.
     - Halte, Sollzeiten und Bahnsteig-Koordinaten: daten/ansagen.js (wird
       erst geladen, wenn die Ansagen eingeschaltet werden). Erzeugt von
       tracker/ansagedaten_erzeugen.py aus Tracker-Messungen und OSM.

   Wann wird angesagt?
     - Angesagt wird immer nur der NAECHSTE Halt, also der erste, der noch
       nicht erreicht ist – und erst, wenn der Zug den Halt davor wieder
       verlassen hat.
     - Erreicht ist ein Halt, wenn der Zug bis auf 400 m heran war, oder
       wenn er sichtbar daran vorbeigefahren ist.
     - Halte ohne bekannte Lage werden direkt nach der Abfahrt vom vorigen
       Halt angesagt.
     - SimRail erneuert die Positionen nur etwa alle 5–7 Sekunden. Damit die
       Ansage nicht zu spaet kommt, rechnen wir den Weg bis zur naechsten
       Meldung dazu (VORLAUF).

   Der Takt laeuft in einem kleinen Hintergrund-Arbeiter (Web Worker):
   Browser bremsen normale Zeitgeber in versteckten Tabs auf einmal pro
   Minute herunter – Arbeiter aber nicht. Und die App liegt beim Fahren ja
   meist hinter SimRail.                                                    */

(function () {
  "use strict";

  const LIVE_URL = "https://panel.simrail.eu:8084/trains-open?serverCode=de1";
  const DATEN_URL = "daten/ansagen.js?v=20261022";
  const SERVER_ZEITZONE = "Europe/Warsaw";   // Fahrplanzeiten auf DE1 = polnische Ortszeit

  const TAKT_MS = 5000;          // so oft die Live-Daten abfragen
  const VORLAUF_S = 7;           // Weg bis zur naechsten Positionsmeldung einrechnen
  const AM_HALT_M = 400;         // so nah dran = Halt erreicht
  const VORBEI_M = 300;          // so weit wieder weg (nach naher Vorbeifahrt) = vorbei
  const VORSCHAU = 5;            // so viele kommende Halte betrachten
  const MAX_VERSPAETUNG = 360;   // groessere Werte sind unplausibel

  const S_EINSTELLUNGEN = "simrail_ansage";      // Sprache, Stimme ... (wandert mit dem Konto)
  const S_STEAM = "simrail_steamId";             // wandert mit dem Konto
  const S_AN = "simrail_ansage_an";              // an/aus gilt nur fuer dieses Geraet

  const zustand = {
    takt: null, laeuft: false,
    lauf: null,                  // RunId der aktuellen Fahrt
    angesagt: new Set(),         // schon angesagte Halte
    erreicht: new Set(),         // schon erreichte (oder passierte) Halte
    abstaende: new Map(),        // letzter gemessener Abstand je Halt
    richtung: new Map(),         // -1 = Zug kam zuletzt naeher, +1 = entfernte sich
    naechst: new Map(),          // kleinster bisher gemessener Abstand je Halt
    zuletzt: null,               // {name, zeit} der letzten Ansage
    testZug: null                // zum Ausprobieren: Ansagen fuer einen beliebigen Zug
  };

  const $ = id => document.getElementById(id);
  function sicher(x) {
    return String(x == null ? "" : x).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  /* ---- Einstellungen ------------------------------------------------------ */

  function einstellungen() {
    let e = {};
    try { e = JSON.parse(localStorage.getItem(S_EINSTELLUNGEN) || "{}"); } catch (x) {}
    return {
      an: localStorage.getItem(S_AN) === "1",
      abstand: Number(e.abstand) || 1000, stimme: e.stimme || "",
      sprache: SPRACHEN[e.sprache] ? e.sprache : "pl",
      lautstaerke: Number(e.lautstaerke) || 1, gong: e.gong !== false,
      fern: e.fern !== false
    };
  }

  function einstellungenSpeichern() {
    // Neue Sprache? Dann passt die gewaehlte Stimme nicht mehr - automatisch waehlen
    const sprache = $("ansageSprache").value;
    const neueSprache = sprache !== einstellungen().sprache;
    localStorage.setItem(S_EINSTELLUNGEN, JSON.stringify({
      fern: $("ansageFern").checked,
      abstand: Number($("ansageAbstand").value),
      sprache: sprache,
      stimme: neueSprache ? "" : $("ansageStimme").value,
      lautstaerke: Number($("ansageLautstaerke").value),
      gong: $("ansageGong").checked
    }));
    localStorage.setItem(S_AN, $("ansageAn").checked ? "1" : "0");
    const steam = $("ansageSteamId").value.trim();
    if (steam) localStorage.setItem(S_STEAM, steam);
    else localStorage.removeItem(S_STEAM);
    if (neueSprache) stimmenLaden();
    starten();
  }

  // Passende Stimmen in die Auswahl eintragen. Die Liste kommt bei manchen
  // Browsern erst verzoegert, deshalb auch bei 'voiceschanged'.
  function stimmenLaden() {
    if (!("speechSynthesis" in window)) {
      $("ansageStimmenHinweis").textContent = "Dieser Browser kann keine Sprachausgabe.";
      return;
    }
    const e = einstellungen();
    const spr = SPRACHEN[e.sprache];
    const passend = speechSynthesis.getVoices().filter(v => spr.stimme.test(v.lang));
    $("ansageStimme").innerHTML = passend.length
      ? passend.map(v => '<option value="' + sicher(v.name) + '"' +
                         (v.name === e.stimme ? " selected" : "") + ">" + sicher(v.name) + "</option>").join("")
      : '<option value="">Standardstimme (keine ' + spr.adjektiv + " installiert)</option>";
    const ohnePolnisch = e.sprache !== "pl" && !speechSynthesis.getVoices().some(v => /^pl/i.test(v.lang));
    $("ansageStimmenHinweis").innerHTML = passend.length
      ? (ohnePolnisch ? "Für die polnische Aussprache der Ortsnamen fehlt eine polnische Stimme – " +
                        "die Namen spricht dann die gewählte Stimme. Abhilfe: im <b>Microsoft Edge</b> " +
                        "oder <b>Google Chrome</b> öffnen (bringen polnische Online-Stimmen mit)." : "")
      : "Auf diesem Gerät ist keine " + spr.adjektiv + " Stimme installiert. Abhilfe: im " +
        "<b>Microsoft Edge</b> öffnen (bringt Online-Stimmen in vielen Sprachen mit) oder in " +
        "Windows unter <i>Einstellungen → Zeit und Sprache → Sprache</i> „" + spr.windows +
        "“ mit Sprachausgabe hinzufügen.";
  }

  /* ---- Ton und Sprache ---------------------------------------------------- */

  // Ein kurzer Zweiklang wie vor echten Bahnhofsdurchsagen
  function gong() {
    return new Promise(function (fertig) {
      try {
        const ton = new (window.AudioContext || window.webkitAudioContext)();
        const laut = einstellungen().lautstaerke * 0.35;
        [[784, 0], [622, 0.45]].forEach(function (t) {
          const osz = ton.createOscillator(), huelle = ton.createGain();
          osz.frequency.value = t[0];
          huelle.gain.setValueAtTime(0, ton.currentTime + t[1]);
          huelle.gain.linearRampToValueAtTime(laut, ton.currentTime + t[1] + 0.02);
          huelle.gain.exponentialRampToValueAtTime(0.001, ton.currentTime + t[1] + 1.1);
          osz.connect(huelle).connect(ton.destination);
          osz.start(ton.currentTime + t[1]);
          osz.stop(ton.currentTime + t[1] + 1.2);
        });
        setTimeout(function () { ton.close(); fertig(); }, 1500);
      } catch (x) { fertig(); }
    });
  }

  /* Stationsnamen bleiben in jeder Sprache polnisch und werden auch polnisch
     ausgesprochen: In deutschen und englischen Ansagen werden sie markiert
     (PL_AUF ... PL_ZU), und sprechen() laesst sie von einer polnischen
     Stimme sprechen - eine deutsche Stimme machte aus "Płaszów" oder
     "Ochota" etwas ganz anderes. Zur Anzeige entfernt ohneMarken() die Marken. */
  const PL_AUF = "", PL_ZU = "";
  function ohneMarken(text) { return String(text || "").replace(/[]/g, ""); }
  function stationsname(name, sprache) {
    if (!name || sprache === "pl") return name;
    return PL_AUF + name + PL_ZU;
  }

  async function sprechen(text) {
    if (!("speechSynthesis" in window)) return;
    const e = einstellungen();
    if (e.gong) await gong();
    const spr = SPRACHEN[e.sprache];
    const stimmen = speechSynthesis.getVoices();
    const hauptstimme = stimmen.find(v => v.name === e.stimme && spr.stimme.test(v.lang)) ||
                        stimmen.find(v => spr.stimme.test(v.lang));
    const polnischeStimme = stimmen.find(v => /^pl/i.test(v.lang));
    speechSynthesis.cancel();
    // In Abschnitte zerlegen: polnische Namen (markiert) mit polnischer Stimme,
    // der Rest mit der gewaehlten. Die Sprachausgabe reiht sie nahtlos aneinander.
    const abschnitte = [];
    for (const stueck of String(text).split(/([^]*)/)) {
      let rest = stueck;
      // Satzzeichen am ANFANG eines Abschnitts liest eine Stimme als Wort vor
      // ("Punkt", "Komma"). Am Ende des vorigen Abschnitts ist es stumm.
      const zeichen = rest.match(/^\s*([.,;:!?]+)/);
      if (zeichen && abschnitte.length) {
        abschnitte[abschnitte.length - 1].text += zeichen[1];
        rest = rest.slice(zeichen[0].length);
      }
      if (!ohneMarken(rest).trim()) continue;
      abschnitte.push({ polnisch: rest[0] === PL_AUF, text: ohneMarken(rest).trim() });
    }
    for (const abschnitt of abschnitte) {
      const polnisch = abschnitt.polnisch && polnischeStimme;
      const satz = new SpeechSynthesisUtterance(abschnitt.text);
      const stimme = polnisch ? polnischeStimme : hauptstimme;
      satz.lang = polnisch ? "pl-PL" : spr.lang;
      if (stimme) satz.voice = stimme;
      satz.volume = e.lautstaerke;
      satz.rate = 0.95;
      speechSynthesis.speak(satz);
    }
  }

  /* ---- Ansagetexte je Sprache ---------------------------------------------
     Jede Sprache baut ihre Saetze selbst - woertlich uebersetzt klingen
     Durchsagen schief. Deutsch angelehnt an DB-Durchsagen, Englisch an
     britische Bahnansagen. Umstiegsmoeglichkeiten kommen spaeter dazu.     */

  const SPRACHEN = {
    pl: {
      lang: "pl-PL", stimme: /^pl/i, adjektiv: "polnische", windows: "Polski",
      halt: n => "Następna stacja: " + n + ".",
      ende: n => "Stacja końcowa: " + n + ". Dziękujemy za wspólną podróż."
    },
    de: {
      lang: "de-DE", stimme: /^de/i, adjektiv: "deutsche", windows: "Deutsch",
      halt: n => "Nächster Halt: " + n + ".",
      ende: n => "Nächster Halt: " + n + ". Dieser Zug endet dort. Vielen Dank für Ihre Reise."
    },
    en: {
      lang: "en-GB", stimme: /^en/i, adjektiv: "englische", windows: "English",
      halt: n => "The next stop is " + n + ".",
      ende: n => "The next stop is " + n + ", where this train terminates. Thank you for travelling with us."
    }
  };

  function haltText(halt) {
    const sprache = einstellungen().sprache;
    const name = stationsname(halt.ansage, sprache);
    return halt.ende ? SPRACHEN[sprache].ende(name) : SPRACHEN[sprache].halt(name);
  }

  /* ---- Fernverkehr: Ansagen wie vom Zugbegleiter ---------------------------
     Kurz nach jeder Abfahrt eine Begruessung (Zug, naechster Halt,
     Ankunftszeit, ggf. Verspaetung) und einige Minuten vor dem naechsten
     Halt die Ankunft mit Verabschiedung. Damit es nicht nach Automat klingt:
     Tageszeit-Gruss, leicht wechselnde Formulierungen, Entschuldigung bei
     Verspaetung.                                                            */
  const FERN_VERSPAETUNG_AB = 3;     // ab so vielen Minuten wird die Verspaetung erwaehnt
  const FERN_GRUSS_M = 800;          // so weit nach dem Bahnhof kommt die Begruessung
  const FERN_ANKUNFT_S = 150;        // so lange (Sekunden) vor der Ankunft die Verabschiedung ...
  const FERN_ANKUNFT_MIN_M = 2000;   // ... aber mindestens so viele Meter vorher

  function zufall(liste) { return liste[Math.floor(Math.random() * liste.length)]; }

  // Uhrzeit auf dem Server (polnische Ortszeit) - egal, wo der Spieler sitzt
  function serverJetzt() {
    const teile = new Intl.DateTimeFormat("en-GB", { timeZone: SERVER_ZEITZONE, hour: "2-digit",
                                                     minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date());
    const wert = typ => Number(teile.find(t => t.type === typ).value);
    return { stunde: wert("hour"), minuten: wert("hour") * 60 + wert("minute") };
  }
  function tageszeit() { return serverJetzt().stunde; }

  function hhmm(minuten) {
    if (minuten == null) return "";
    const m = ((minuten % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  }

  // Abstand zur aktuellen Serverzeit, ueber Mitternacht hinweg richtig
  function minutenDifferenz(soll) {
    let diff = serverJetzt().minuten - soll;
    if (diff < -720) diff += 1440;
    if (diff > 720) diff -= 1440;
    return diff;
  }

  // Polnisch: 1 minutę, 2-4 minuty, 5+ minut (12-14 minut)
  function minutyPl(n) {
    if (n === 1) return "minutę";
    const e = n % 10, z = n % 100;
    return e >= 2 && e <= 4 && !(z >= 12 && z <= 14) ? "minuty" : "minut";
  }

  // Zugmarke im Fernverkehr ("Express InterCity Premium", "TLK" ...)
  function fernMarke(kategorie) {
    const k = String(kategorie || "").trim();
    return { EIP: "Express InterCity Premium", EIC: "Express InterCity", EC: "EuroCity", IC: "InterCity",
             ICN: "InterCity", TLK: "TLK", IR: "InterRegio" }[k] || k;
  }

  const FERN_TEXTE = {
    pl: {
      gruss: function (z) {
        const h = tageszeit();
        const hallo = h < 18 ? "Dzień dobry," : "Dobry wieczór,";
        let t = zufall([
          hallo + " Szanowni Państwo. Witamy serdecznie w pociągu " + z.marke + " numer " + z.nr +
            " relacji " + z.start + " – " + z.ziel + ".",
          "Szanowni Państwo, " + (h < 18 ? "dzień dobry" : "dobry wieczór") + ". Kierownik pociągu " +
            z.marke + " numer " + z.nr + " relacji " + z.start + " – " + z.ziel + " wita Państwa na pokładzie."
        ]);
        t += " Następna stacja: " + z.halt + ", " + (z.verspaetung >= FERN_VERSPAETUNG_AB
          ? "planowy przyjazd o godzinie " + z.plan + "."
          : "przyjazd planowo o godzinie " + z.plan + ".");
        if (z.verspaetung >= FERN_VERSPAETUNG_AB) {
          t += " " + zufall(["Niestety nasz pociąg jest obecnie opóźniony o około " + z.verspaetung + " " +
                             minutyPl(z.verspaetung) + ".",
                             "Przepraszamy, mamy w tej chwili około " + z.verspaetung + " " +
                             minutyPl(z.verspaetung) + " opóźnienia."]) +
               " Przewidywany przyjazd do stacji " + z.halt + " około godziny " + z.erwartet +
               ". Przepraszamy za utrudnienia.";
        }
        return t + " " + zufall(["Życzymy Państwu przyjemnej podróży.", "Życzymy miłej i spokojnej podróży."]);
      },
      ankunft: function (z) {
        let t = z.ende
          ? "Szanowni Państwo, za kilka minut przyjedziemy do stacji końcowej " + z.halt + "."
          : zufall(["Szanowni Państwo, za kilka minut przyjedziemy do stacji " + z.halt + ".",
                    "Szanowni Państwo, zbliżamy się do stacji " + z.halt + "."]);
        t += z.verspaetung >= FERN_VERSPAETUNG_AB
          ? " Przyjazd przewidywany około godziny " + z.erwartet + ", z opóźnieniem około " +
            z.verspaetung + " " + minutyPl(z.verspaetung) + ". Jeszcze raz przepraszamy."
          : " Przyjazd planowo o godzinie " + z.plan + ".";
        t += z.ende
          ? " Prosimy o sprawdzenie, czy nie pozostawili Państwo swoich rzeczy. Dziękujemy za wspólną podróż i zapraszamy ponownie."
          : " Pasażerów wysiadających prosimy o zabranie bagażu. " +
            zufall(["Dziękujemy za wspólną podróż.", "Dziękujemy i do zobaczenia."]);
        return t;
      }
    },
    de: {
      gruss: function (z) {
        const h = tageszeit();
        const hallo = h < 10 ? "Guten Morgen" : h < 18 ? "Guten Tag" : "Guten Abend";
        let t = zufall([
          hallo + ", meine Damen und Herren, herzlich willkommen im " + z.marke + " " + z.nr + " von " +
            z.start + " nach " + z.ziel + ".",
          "Meine Damen und Herren, " + hallo.replace(/^G/, "g") + " und herzlich willkommen an Bord des " +
            z.marke + " " + z.nr + " nach " + z.ziel + "."
        ]);
        t += " Unser nächster Halt ist " + z.halt + ", dort kommen wir " +
             (z.verspaetung >= FERN_VERSPAETUNG_AB ? "planmäßig" : zufall(["planmäßig", "pünktlich"])) +
             " um " + z.plan + " Uhr an.";
        if (z.verspaetung >= FERN_VERSPAETUNG_AB) {
          t += " " + zufall(["Wir haben im Moment leider eine Verspätung von etwa " + z.verspaetung + " Minuten.",
                             "Leider sind wir zurzeit rund " + z.verspaetung + " Minuten verspätet."]) +
               " Die Ankunft in " + z.halt + " ist deshalb voraussichtlich gegen " + z.erwartet +
               " Uhr. Wir bitten um Ihr Verständnis.";
        }
        return t + " " + zufall(["Wir wünschen Ihnen eine angenehme Reise.",
                                 "Ich wünsche Ihnen eine angenehme Fahrt mit uns."]);
      },
      ankunft: function (z) {
        let t = z.ende
          ? "Meine Damen und Herren, in wenigen Minuten erreichen wir " + z.halt + ", den Endbahnhof dieses Zuges."
          : zufall(["Meine Damen und Herren, in wenigen Minuten erreichen wir " + z.halt + ".",
                    "Meine Damen und Herren, wir erreichen in Kürze " + z.halt + "."]);
        t += z.verspaetung >= FERN_VERSPAETUNG_AB
          ? " Ankunft dort voraussichtlich gegen " + z.erwartet + " Uhr, mit etwa " + z.verspaetung +
            " Minuten Verspätung. Wir bitten nochmals um Entschuldigung."
          : " Ankunft dort planmäßig um " + z.plan + " Uhr.";
        const abend = tageszeit() >= 18 ? "Abend" : "Tag";
        t += z.ende
          ? " Bitte steigen Sie dort alle aus und denken Sie an Ihr Gepäck. Vielen Dank, dass Sie mit uns gereist sind, und noch einen schönen " + abend + "."
          : " Wenn Sie aussteigen, denken Sie bitte an Ihr Gepäck. " +
            zufall(["Wir verabschieden uns von allen Fahrgästen, die uns hier verlassen.",
                    "Vielen Dank für Ihre Reise mit uns und noch einen schönen " + abend + "."]);
        return t;
      }
    },
    en: {
      gruss: function (z) {
        const h = tageszeit();
        const hallo = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
        let t = zufall([
          hallo + ", ladies and gentlemen, and welcome aboard this " + z.marke + " service, number " + z.nr +
            ", from " + z.start + " to " + z.ziel + ".",
          hallo + ", everyone, and a very warm welcome on board the " + z.marke + " to " + z.ziel + "."
        ]);
        t += " Our next stop will be " + z.halt + ", where we're due to arrive at " + z.plan + ".";
        if (z.verspaetung >= FERN_VERSPAETUNG_AB) {
          t += " " + zufall(["We're currently running around " + z.verspaetung + " minutes late,",
                             "I'm afraid we're running about " + z.verspaetung + " minutes behind schedule at the moment,"]) +
               " so we're now expecting to get into " + z.halt + " at about " + z.erwartet + ". Sorry about that.";
        }
        return t + " " + zufall(["Sit back, relax and enjoy your journey.", "Thanks for travelling with us today."]);
      },
      ankunft: function (z) {
        let t = z.ende
          ? "Ladies and gentlemen, we'll shortly be arriving at " + z.halt + ", where this train terminates."
          : zufall(["Ladies and gentlemen, we'll shortly be arriving at " + z.halt + ".",
                    "Ladies and gentlemen, in just a few minutes we'll be arriving at " + z.halt + "."]);
        t += z.verspaetung >= FERN_VERSPAETUNG_AB
          ? " We're expecting to get in at around " + z.erwartet + ", roughly " + z.verspaetung +
            " minutes late. Apologies again for the delay."
          : " We're due in at " + z.plan + ".";
        const tag = tageszeit() >= 18 ? "evening" : "day";
        t += z.ende
          ? " All change, please. Do make sure you take all your belongings with you. Thank you for travelling with us, and have a lovely " + tag + "."
          : " If you're leaving us here, please make sure you take all your belongings with you. Thanks for travelling with us, and have a lovely " + tag + ".";
        return t;
      }
    }
  };

  // Gemeinsame Angaben fuer beide Fernverkehrs-Ansagen
  function fernDaten(d, halt) {
    const sprache = einstellungen().sprache;
    const verspaetung = Math.max(0, d.verspaetung || 0);
    return {
      sprache,
      marke: fernMarke(d.kategorie), nr: d.zug,
      start: stationsname(d.start || "", sprache), ziel: stationsname(d.ziel || "", sprache),
      halt: stationsname(halt.ansage, sprache), ende: !!halt.ende,
      plan: hhmm(halt.plan), erwartet: hhmm(halt.plan + verspaetung), verspaetung
    };
  }

  function istFernverkehr(d) {
    return d && d.gruppe === "Fernverkehr" && einstellungen().fern;
  }

  /* ---- Daten -------------------------------------------------------------- */

  let datenLaden = null;
  function datenHolen() {
    if (window.ANSAGE_DATEN) return Promise.resolve(window.ANSAGE_DATEN);
    if (!datenLaden) {
      datenLaden = new Promise(function (fertig, fehler) {
        const skript = document.createElement("script");
        skript.src = DATEN_URL;
        // "const ANSAGE_DATEN" landet nicht an window - deshalb hier abholen
        skript.onload = function () {
          try { window.ANSAGE_DATEN = ANSAGE_DATEN; fertig(window.ANSAGE_DATEN); }   // eslint-disable-line no-undef
          catch (x) { datenLaden = null; fehler(x); }
        };
        skript.onerror = function () { datenLaden = null; skript.remove(); fehler(new Error("Ansagedaten")); };
        document.head.appendChild(skript);
      });
    }
    return datenLaden;
  }

  // Baut aus Live-Zug und Fahrplandaten dasselbe, was im lokalen Addon der
  // Tracker liefert: Position, Tempo, Verspaetung und die naechsten Halte.
  function zugDaten(live, daten) {
    const t = live.TrainData || {};
    const nummer = String(live.TrainNoLocal);
    const info = daten.zuege[nummer];
    const grund = { faehrt: true, zug: nummer, lauf: live.RunId, lat: t.Latititute, lon: t.Longitute,
                    tempo: t.Velocity, index: t.VDDelayedTimetableIndex || 0 };
    if (!info) return Object.assign(grund, { gruppe: null, kategorie: null, halte: [] });

    // Verspaetung = Serverzeit minus Sollzeit am zuletzt passierten Fahrplanpunkt
    const soll = info.t[grund.index];
    let verspaetung = soll == null ? null : minutenDifferenz(soll);
    if (verspaetung !== null && Math.abs(verspaetung) > MAX_VERSPAETUNG) verspaetung = null;

    // Kommende Halte: ab einem Punkt VOR dem Index, denn der Index springt
    // manchmal schon kurz vor dem Bahnhof weiter.
    const halte = info.h.filter(h => h[0] >= grund.index - 1).slice(0, VORSCHAU).map(h => ({
      nr: h[0], ansage: daten.namen[h[1]], plan: h[2], lat: h[3], lon: h[4], ende: h[5] === 1
    }));
    return Object.assign(grund, {
      kategorie: info.k,
      gruppe: info.g === "F" ? "Fernverkehr" : "Nahverkehr",
      regional: info.g === "N",
      verspaetung,
      start: daten.namen[info.s], ziel: daten.namen[info.z],
      halte
    });
  }

  /* ---- Ablauf ------------------------------------------------------------- */

  function anzeigen(html, warnung) {
    const e = einstellungen();
    $("ansageStatus").innerHTML = html;
    const leiste = $("ansageLeiste");
    leiste.innerHTML = (zustand.testZug ? "Test Zug " + sicher(zustand.testZug) + ": " : "") + html;
    leiste.classList.toggle("warn", !!warnung);
    leiste.hidden = !e.an && !zustand.testZug;
  }

  function starten() {
    const e = einstellungen();
    if (zustand.takt) { zustand.takt.stop(); zustand.takt = null; }
    if (!e.an && !zustand.testZug) {
      $("ansageLeiste").hidden = true;
      $("ansageStatus").textContent = "Ansagen sind aus.";
      return;
    }
    // Takt im Hintergrund-Arbeiter; klappt das nicht, tut es auch ein normaler Zeitgeber.
    try {
      const code = "setInterval(function(){postMessage(0)}," + TAKT_MS + ")";
      const arbeiter = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
      arbeiter.onmessage = runde;
      zustand.takt = { stop: function () { arbeiter.terminate(); } };
    } catch (x) {
      const nr = setInterval(runde, TAKT_MS);
      zustand.takt = { stop: function () { clearInterval(nr); } };
    }
    anzeigen(window.ANSAGE_DATEN ? "Ansagen an – frage SimRail ab …" : "Ansagen an – lade Fahrplandaten …");
    runde();
  }

  async function runde() {
    if (zustand.laeuft) return;          // vorige Anfrage haengt noch
    zustand.laeuft = true;
    try {
      const kennung = (localStorage.getItem(S_STEAM) || "").trim();
      if (!zustand.testZug && !kennung) {
        anzeigen("Trag oben deine Steam-ID ein – daran erkennt die App deinen Zug.", true);
        return;
      }
      let daten;
      try { daten = await datenHolen(); }
      catch (x) { anzeigen("Fahrplandaten für die Ansagen konnten nicht geladen werden.", true); return; }
      let zuege;
      try {
        const antwort = await fetch(LIVE_URL, { cache: "no-store" });
        if (!antwort.ok) throw new Error("HTTP " + antwort.status);
        const json = await antwort.json();
        zuege = Array.isArray(json) ? json : json.data || [];
      } catch (x) {
        anzeigen("SimRail-Server gerade nicht erreichbar – neuer Versuch in wenigen Sekunden.", true);
        return;
      }
      const live = zuege.find(z => {
        const t = z.TrainData || {};
        return zustand.testZug ? String(z.TrainNoLocal) === zustand.testZug
                               : [t.ControlledBySteamID, t.ControlledByXboxID].some(x => x && String(x) === kennung);
      });
      auswerten(live ? zugDaten(live, daten) : { faehrt: false });
    } finally {
      zustand.laeuft = false;
    }
  }

  function auswerten(d) {
    if (!d.faehrt) {
      anzeigen(zustand.testZug ? "Zug " + sicher(zustand.testZug) + " ist gerade nicht auf der Karte."
                               : "Ansagen an – du fährst gerade keinen Zug auf DE1.");
      return;
    }
    // Neue Fahrt? Dann ist alles bisher Angesagte hinfaellig.
    if (d.lauf !== zustand.lauf) {
      zustand.lauf = d.lauf;
      [zustand.angesagt, zustand.erreicht, zustand.abstaende, zustand.richtung, zustand.naechst]
        .forEach(sammlung => sammlung.clear());
    }
    const zugText = "Zug " + sicher(d.zug) + (d.kategorie ? " (" + sicher(d.kategorie) + ")" : "");
    if (!d.regional && !istFernverkehr(d)) {
      anzeigen(zugText + (d.gruppe === "Fernverkehr"
        ? " ist ein Fernzug – Fernverkehrs-Ansagen sind ausgeschaltet."
        : " ist kein Reisezug – keine Ansagen."));
      return;
    }
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
      anzeigen("Einmal irgendwo auf diese Seite klicken – vorher lässt der Browser " +
               "keine Sprachausgabe zu.", true);
      return;
    }

    const tempo = Math.max(0, d.tempo || 0);
    const schluessel = h => d.lauf + "|" + h.nr;

    // 1. Messen: Abstand, Richtung und kleinster Abstand zu jedem Halt.
    //    Die Richtung merken wir uns von der letzten ECHTEN Bewegung -
    //    zwischen zwei Positionsmeldungen und beim Halten bleibt sie stehen.
    for (const h of d.halte) {
      h.hatOrt = h.lat != null && d.lat != null;
      if (!h.hatOrt) continue;
      const k = schluessel(h);
      h.abstand = abstandMeter(d.lat, d.lon, h.lat, h.lon);
      const vorher = zustand.abstaende.get(k);
      if (vorher === undefined || Math.abs(h.abstand - vorher) > 5) {
        if (vorher !== undefined) zustand.richtung.set(k, h.abstand < vorher ? -1 : 1);
        zustand.abstaende.set(k, h.abstand);
      }
      zustand.naechst.set(k, Math.min(zustand.naechst.get(k) ?? Infinity, h.abstand));
    }

    // Ist der Zug gerade AN einem Halt, liegen alle Halte davor hinter ihm -
    // auch wenn noch keine Bewegung beobachtet wurde (Ansagen erst unterwegs eingeschaltet).
    const amHalt = d.halte.map(h => h.hatOrt && h.abstand < AM_HALT_M).lastIndexOf(true);
    for (let i = 0; i <= amHalt; i++) zustand.erreicht.add(schluessel(d.halte[i]));

    // 2. Halte der Reihe nach abhaken. Der erste, der noch nicht erreicht
    //    ist, ist der naechste - nur der darf angesagt werden.
    let voriger = null, naechster = null;
    for (const h of d.halte) {
      const k = schluessel(h);
      if (!zustand.erreicht.has(k) && haltErreicht(h, k, d, tempo, voriger)) zustand.erreicht.add(k);
      if (zustand.erreicht.has(k)) { voriger = h; continue; }
      naechster = h;
      break;
    }

    // 3. Ansagen - aber erst, wenn der vorige Halt verlassen ist.
    if (istFernverkehr(d)) {
      fernAnsagen(d, voriger, naechster, tempo, schluessel);
    } else if (naechster && !zustand.angesagt.has(schluessel(naechster))) {
      const k = schluessel(naechster);
      const vorigenVerlassen = voriger === null ? naechster.hatOrt
                             : voriger.hatOrt ? voriger.abstand > AM_HALT_M
                             : tempo > 5;
      let jetzt;
      if (naechster.hatOrt) {
        const vorlauf = tempo / 3.6 * VORLAUF_S;
        jetzt = vorigenVerlassen && zustand.richtung.get(k) === -1 &&
                naechster.abstand - vorlauf <= einstellungen().abstand;
      } else {
        // Lage unbekannt: gleich nach der Abfahrt vom vorigen Halt ansagen
        jetzt = voriger !== null && vorigenVerlassen && tempo > 5;
      }
      if (jetzt) {
        zustand.angesagt.add(k);
        merken(naechster.ansage);
        sprechen(haltText(naechster));
      }
    }

    let text = zugText;
    if (naechster) {
      text += " · nächster Halt <b>" + sicher(naechster.ansage) + "</b>" +
              (naechster.hatOrt
                ? " in " + (naechster.abstand / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " km"
                : " (Lage unbekannt – Ansage nach der Abfahrt)");
    }
    if (zustand.zuletzt) {
      text += " · zuletzt angesagt: " + sicher(zustand.zuletzt.name) + " (" + zustand.zuletzt.zeit + ")";
    }
    anzeigen(text);
  }

  function merken(name) {
    zustand.zuletzt = { name, zeit: new Date().toTimeString().slice(0, 5) };
  }

  function fernAnsagen(d, voriger, naechster, tempo, schluessel) {
    if (!naechster) return;
    const k = schluessel(naechster);
    const vorlauf = tempo / 3.6 * VORLAUF_S;
    const ankunftAbstand = Math.max(FERN_ANKUNFT_MIN_M, tempo / 3.6 * FERN_ANKUNFT_S);

    // Ankunft: einige Minuten vorher (ohne bekannte Lage: 3 Minuten vor der Ankunftszeit)
    const kAnkunft = "ankunft|" + k;
    let ankunft = false;
    if (!zustand.angesagt.has(kAnkunft)) {
      if (naechster.hatOrt) {
        ankunft = zustand.richtung.get(k) === -1 && naechster.abstand - vorlauf <= ankunftAbstand;
      } else {
        const rest = -minutenDifferenz(naechster.plan + Math.max(0, d.verspaetung || 0));
        ankunft = rest <= 3 && tempo > 5;
      }
    }

    // Begruessung: kurz nach der Abfahrt (vom Start oder vom vorigen Halt)
    const kGruss = "gruss|" + d.lauf + "|" + (voriger ? voriger.nr : "start");
    const abgefahren = voriger && voriger.hatOrt ? voriger.abstand > FERN_GRUSS_M : tempo > 20;
    if (!ankunft && abgefahren && !zustand.angesagt.has(kGruss)) {
      zustand.angesagt.add(kGruss);
      // Liegt der naechste Halt sehr nah, reicht die Ankunftsansage
      if (!(naechster.hatOrt && naechster.abstand < 2 * ankunftAbstand)) {
        merken("Begrüßung");
        const z = fernDaten(d, naechster);
        sprechen(FERN_TEXTE[z.sprache].gruss(z));
        return;
      }
    }

    if (ankunft) {
      zustand.angesagt.add(kAnkunft);
      zustand.angesagt.add(k);               // fuer "Halt erreicht" ohne bekannte Lage
      merken(naechster.ansage);
      const z = fernDaten(d, naechster);
      sprechen(FERN_TEXTE[z.sprache].ankunft(z));
    }
  }

  // Hat der Zug diesen Halt schon erreicht oder hinter sich gelassen?
  function haltErreicht(h, k, d, tempo, voriger) {
    const richtung = zustand.richtung.get(k);
    if (h.hatOrt) {
      if (h.abstand < AM_HALT_M) return true;
      // nah vorbeigefahren und entfernt sich jetzt deutlich
      const naechst = zustand.naechst.get(k);
      if (naechst < 1500 && h.abstand > naechst + VORBEI_M && richtung === 1) return true;
      // laut Fahrplanindex schon hinter uns, und wir entfernen uns
      return h.nr < d.index && richtung === 1;
    }
    // Ohne Lage: Der Fahrplanindex ist daran vorbei, oder der Zug hat nach
    // der Ansage gehalten - abseits vom vorigen Halt.
    if (h.nr < d.index) return true;
    const abseits = !voriger || !voriger.hatOrt || voriger.abstand > AM_HALT_M;
    return zustand.angesagt.has(k) && tempo < 1 && abseits;
  }

  // Abstand zweier Koordinaten in Metern (fuer ein paar Kilometer genau genug)
  function abstandMeter(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const x = (lon2 - lon1) * r * Math.cos((lat1 + lat2) / 2 * r);
    const y = (lat2 - lat1) * r;
    return 6371000 * Math.hypot(x, y);
  }

  function probe() {
    sprechen(haltText({ ansage: "Łódź Kaliska" }));
  }

  /* ---- Einrichten --------------------------------------------------------- */

  function einrichten() {
    if (!$("ansageAn")) return;
    const e = einstellungen();
    $("ansageAn").checked = e.an;
    $("ansageFern").checked = e.fern;
    $("ansageAbstand").value = String(e.abstand);
    $("ansageSprache").value = e.sprache;
    $("ansageLautstaerke").value = String(e.lautstaerke);
    $("ansageGong").checked = e.gong;
    $("ansageSteamId").value = localStorage.getItem(S_STEAM) || "";
    ["ansageAn", "ansageFern", "ansageAbstand", "ansageSprache", "ansageStimme", "ansageLautstaerke",
     "ansageGong", "ansageSteamId"].forEach(id => $(id).addEventListener("change", einstellungenSpeichern));
    $("ansageProbe").addEventListener("click", probe);
    stimmenLaden();
    if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = stimmenLaden;
    starten();
  }

  // Zum Ausprobieren in der Browser-Konsole: SimRailAnsage.test("14100")
  // laesst die Ansagen fuer einen beliebigen Zug auf DE1 laufen, test() beendet das.
  window.SimRailAnsage = {
    test: function (zug) { zustand.testZug = zug ? String(zug) : null; zustand.lauf = null; starten(); },
    probe
  };

  einrichten();
})();
