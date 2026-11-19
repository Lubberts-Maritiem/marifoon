// api/waarneming.js
// Actuele KNMI-waarneming van één station, uit de tabel op
// https://www.knmi.nl/nederland-nu/weer/waarnemingen (elke 10 minuten bijgewerkt).
//
// Waarom: het zicht van Open-Meteo is een modelwaarde voor een rasterpunt en
// week op 19 nov 2026 sterk af van de meting (3,2 km tegenover 8 km gemeten
// op Terschelling). Het KNMI meet het zicht op het station zelf.
//
// Server-side, net als api/marifoon.js: de KNMI-pagina staat geen
// browseraanroepen van andere sites toe, en zo belasten we knmi.nl niet per
// bezoeker.

import { nlNaarDate } from "./_waddendata.js";

const SOURCE_URL = "https://www.knmi.nl/nederland-nu/weer/waarnemingen";
const CACHE_TTL_MS = 5 * 60 * 1000; // KNMI vernieuwt elke 10 minuten
let cache = null; // { html-afgeleide data, fetchedAt }

const MAANDEN = {
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6,
  juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
};

export default async function handler(req, res) {
  const gevraagd = String(req.query?.station || "Terschelling").trim().toLowerCase();

  try {
    if (!cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
      const response = await fetch(SOURCE_URL, {
        headers: { "User-Agent": "wadoversteken.nl marifoon-widget (contact via wadoversteken.nl)" },
      });
      if (!response.ok) throw new Error(`KNMI-pagina gaf status ${response.status}`);
      cache = { data: leesTabel(await response.text()), fetchedAt: Date.now() };
    }

    const { tijdstip, stations } = cache.data;
    const rij = stations.find((s) => s.station.toLowerCase() === gevraagd);
    if (!rij) {
      return res.status(404).json({
        error: "Station niet gevonden",
        stations: stations.map((s) => s.station),
      });
    }

    res.setHeader("Cache-Control", "public, max-age=120");
    return res.status(200).json({
      ...rij,
      tijdstip,
      bron: SOURCE_URL,
      licentie: "Bron: KNMI (knmi.nl). Automatisch overgenomen, geen officiële distributie.",
    });
  } catch (err) {
    console.error("Waarneming ophalen mislukt:", err);
    return res.status(502).json({ error: "Kon KNMI-waarneming niet ophalen", detail: String(err.message || err) });
  }
}

function tekst(html) {
  return html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function getal(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function leesTabel(html) {
  // Tijdstip, bijvoorbeeld "19 november 2026 11:30 uur".
  let tijdstip = null;
  const m = tekst(html).match(/(\d{1,2}) (januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december) (\d{4})\D{0,20}?(\d{1,2}):(\d{2})/i);
  if (m) tijdstip = nlNaarDate(+m[3], MAANDEN[m[2].toLowerCase()], +m[1], +m[4], +m[5]).toISOString();

  // Kolommen op naam opzoeken, zodat een extra kolom de rest niet verschuift.
  const thead = html.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || "";
  const koppen = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((k) => tekst(k[1]).toLowerCase());
  const kolom = (deel) => koppen.findIndex((k) => k.startsWith(deel));
  const K = {
    station: kolom("station"), weer: kolom("weer"), temp: kolom("temp"), rv: kolom("rv"),
    windBft: kolom("wind (bft)"), windMs: kolom("wind (m/s)"), stoot: kolom("windstoot"),
    zicht: kolom("zicht"), druk: kolom("druk"),
  };
  if (K.station < 0 || K.zicht < 0) throw new Error("Kolommen niet gevonden in de KNMI-tabel");

  const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || "";
  const stations = [];
  for (const tr of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cellen = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => tekst(c[1]));
    if (!cellen[K.station]) continue;
    const windBft = cellen[K.windBft] || "";
    const [, richting = null, kracht = null] = windBft.match(/^([A-Z]+)?\s*(\d+)?/) || [];
    stations.push({
      station: cellen[K.station],
      weer: cellen[K.weer] || null,
      temperatuurC: getal(cellen[K.temp]),
      vochtigheid: getal(cellen[K.rv]),
      windRichting: richting,
      windBft: getal(kracht),
      windMs: getal(cellen[K.windMs]),
      windstootKmh: getal(cellen[K.stoot]),
      zichtM: getal(cellen[K.zicht]),
      drukHpa: getal(cellen[K.druk]),
    });
  }
  return { tijdstip, stations };
}
