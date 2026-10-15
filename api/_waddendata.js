// api/_waddendata.js
// Eén plek waar de waddendata-feed binnenkomt, gedeeld door /api/getij en
// /api/golven. Het onderstreepje voorop houdt dit bestand uit de routering
// van Vercel, het is een hulpmodule en geen eindpunt.
//
// De feed loopt over een websocket. Na verbinden stuurt de server zijn
// volledige momentopname, één JSON met onder meer Tides, waterstanden,
// WaterstandenAstroPredict, golven, Golven_Predict, meteo en KNMI. We nemen
// die eerste boodschap en sluiten meteen weer af.
//
// Node 22 heeft een ingebouwde WebSocket, er is dus geen "ws"-pakket nodig.

const WADDENDATA_WS = "wss://data.waddendata.nl";

// Alle locaties zitten in dezelfde boodschap, dus één ophaalactie bedient
// elk eindpunt en elke plaats.
let cache = null; // { bericht, fetchedAt }
let lopend = null; // de vlucht die nu bezig is, zodat we er niet twee starten
const TTL_MS = 10 * 60 * 1000;

export function haalWaddendata() {
  const nu = Date.now();
  if (cache && nu - cache.fetchedAt < TTL_MS) return Promise.resolve(cache.bericht);
  if (lopend) return lopend;

  lopend = new Promise((resolve, reject) => {
    let ws;
    let klaar = false;

    const stop = (fn, arg) => {
      if (klaar) return;
      klaar = true;
      clearTimeout(timer);
      lopend = null;
      try { ws?.close(); } catch { /* al dicht */ }
      fn(arg);
    };

    const timer = setTimeout(
      () => stop(reject, new Error("waddendata gaf geen antwoord binnen 8 seconden")),
      8000
    );

    try {
      ws = new WebSocket(WADDENDATA_WS, { headers: { Origin: "https://www.waddendata.nl" } });
    } catch (e) {
      return stop(reject, e);
    }

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        if (!data?.Tides) throw new Error("geen Tides in de boodschap");
        cache = { bericht: data, fetchedAt: Date.now() };
        stop(resolve, data);
      } catch (e) {
        stop(reject, e);
      }
    };
    ws.onerror = () => stop(reject, new Error("websocketfout bij waddendata"));
    ws.onclose = () => stop(reject, new Error("waddendata sloot de verbinding zonder data"));
  });

  return lopend;
}

// ── Tijd ─────────────────────────────────────────────────────────────────────
// Waddendata geeft tijden als "2026-10-16 00:40" in Nederlandse kloktijd,
// zonder offset. Zonder library bepalen we de offset door een eerste gok terug
// te rekenen via Intl, en die correctie toe te passen. Tweemaal, zodat ook de
// nacht van de klokwissel klopt.

export function tekstNaarDate(tekst) {
  const m = String(tekst).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  return nlNaarDate(+m[1], +m[2], +m[3], +m[4], +m[5]);
}

export function nlNaarDate(jaar, maand, dag, uur, minuut) {
  let ms = Date.UTC(jaar, maand - 1, dag, uur, minuut);
  for (let ronde = 0; ronde < 2; ronde++) {
    ms = Date.UTC(jaar, maand - 1, dag, uur, minuut) - nlOffset(new Date(ms));
  }
  return new Date(ms);
}

function nlOffset(datum) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Amsterdam",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const d = {};
  for (const deel of fmt.formatToParts(datum)) d[deel.type] = deel.value;
  const alsUtc = Date.UTC(d.year, d.month - 1, d.day, d.hour % 24, d.minute, d.second);
  return alsUtc - datum.getTime();
}

// Een station levert "--" in plaats van een getal zodra het niets meet.
export function getal(waarde) {
  if (waarde === "--" || waarde == null || waarde === "") return null;
  const n = Number(waarde);
  return Number.isFinite(n) ? n : null;
}
