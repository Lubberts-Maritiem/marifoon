// api/golven.js
// Golfhoogte rond een zeegat, uit de waddendata-feed.
//
// Per locatie drie boeien naast elkaar, want juist het verschil is het signaal:
// het zeegat zelf, een binnengelegen punt en de Noordzee ernaast. Staat buiten
// 129 cm en in het gat 83, dan weet je wat er op de drempel gebeurt.
//
// De feed geeft per boei:
//   H1d3  gemiddelde golfhoogte van het hoogste derde deel, in cm
//   Hmax  hoogste golf in de meetperiode, in cm
//   Th0   golfrichting in graden, waar de golven vandaan komen
// En in Golven_Predict een verwachting op 6, 12, 18 en 24 uur vooruit.
//
// Niet elke boei levert altijd alles. Een station zonder meting geeft "--"
// terug. Dat wordt hier null, zodat de pagina het veld leeg kan laten in plaats
// van een oud getal te tonen.

import { haalWaddendata, tekstNaarDate, getal } from "./_waddendata.js";

// Per locatie: welke boeien, en welk station voor de watertemperatuur.
// "rol" bepaalt de volgorde en de opmaak op de pagina.
const OPSTELLING = {
  terschelling: {
    label: "Zeegat van Terschelling",
    boeien: [
      { regio: "west", code: "STM1", naam: "Stortemelk", rol: "zeegat", toelichting: "ZS4 · zeegat" },
      { regio: "west", code: "STMO1", naam: "Stortemelk-Oost", rol: "binnen", toelichting: "SM5 · binnen" },
      { regio: "west", code: "ELD1", naam: "Eierlandse Gat", rol: "buiten", toelichting: "ELD1 · buiten" },
    ],
    watertemp: { regio: null, code: "ELD1" },
    wind: { code: "TERS" },
  },
  vlieland: {
    label: "Zeegat van Vlieland",
    boeien: [
      { regio: "west", code: "STM1", naam: "Stortemelk", rol: "zeegat", toelichting: "ZS4 · zeegat" },
      { regio: "west", code: "STMO1", naam: "Stortemelk-Oost", rol: "binnen", toelichting: "SM5 · binnen" },
      { regio: "west", code: "ELD1", naam: "Eierlandse Gat", rol: "buiten", toelichting: "ELD1 · buiten" },
    ],
    watertemp: { code: "ELD1" },
    wind: { code: "TERS" },
  },
  texel: {
    label: "Zeegat van Texel",
    boeien: [
      { regio: "west", code: "ELD1", naam: "Eierlandse Gat", rol: "zeegat", toelichting: "ELD1 · zeegat" },
      { regio: "west", code: "SGAT", naam: "Schulpengat", rol: "binnen", toelichting: "SGAT · binnen" },
      { regio: "west", code: "L91", naam: "Platform L9", rol: "buiten", toelichting: "L91 · Noordzee" },
    ],
    watertemp: { code: "ELD1" },
    wind: { code: "K141" },
  },
  ameland: {
    label: "Zeegat van Ameland",
    boeien: [
      { regio: "oost", code: "SMWG", naam: "Schier Westgat", rol: "zeegat", toelichting: "SMWG · westgat" },
      { regio: "oost", code: "AWG1", naam: "AWG Platform", rol: "binnen", toelichting: "AWG1" },
      { regio: "oost", code: "SMN1", naam: "Schiermonnikoog Noord", rol: "buiten", toelichting: "SMN1 · Noordzee" },
    ],
    watertemp: { code: "NESS" },
    wind: { code: "NESS" },
  },
  schiermonnikoog: {
    label: "Zeegat van Schiermonnikoog",
    boeien: [
      { regio: "oost", code: "SMWG", naam: "Schier Westgat", rol: "zeegat", toelichting: "SMWG · westgat" },
      { regio: "oost", code: "WEW1", naam: "Westereems West", rol: "binnen", toelichting: "WEW1" },
      { regio: "oost", code: "SMN1", naam: "Schiermonnikoog Noord", rol: "buiten", toelichting: "SMN1 · Noordzee" },
    ],
    watertemp: { code: "SMN1" },
    wind: { code: "WIER" },
  },
};

export default async function handler(req, res) {
  const locatieKey = (req.query?.locatie || "terschelling").toLowerCase();
  const opstelling = OPSTELLING[locatieKey];

  if (!opstelling) {
    return res.status(400).json({
      error: "Geen golfopstelling voor deze locatie",
      geldigeOpties: Object.keys(OPSTELLING),
    });
  }

  try {
    const bericht = await haalWaddendata();

    const boeien = opstelling.boeien.map((b) => leesBoei(bericht, b));

    const result = {
      locatieKey,
      zeegat: opstelling.label,
      opgehaaldOp: new Date().toISOString(),
      boeien,
      // De verwachting hoort bij de boei in het zeegat zelf, dat is de reeks
      // waar je op vaart.
      verwachting: leesVerwachting(bericht, opstelling.boeien[0]),
      watertemperatuur: leesWatertemp(bericht, opstelling.watertemp?.code),
      wind: leesWind(bericht, opstelling.wind?.code),
      licentie: "Bron: waddendata.nl (data Rijkswaterstaat).",
    };

    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).json(result);
  } catch (err) {
    console.error("Golven-ophalen mislukt:", err);
    return res.status(502).json({
      error: "Kon golfgegevens niet ophalen",
      detail: String(err.message || err),
    });
  }
}

function leesBoei(bericht, b) {
  const m = bericht?.golven?.[b.regio]?.[b.code] || {};
  const tijd = m.H1d3?.timestamp || m.Hmax?.timestamp || null;

  return {
    code: b.code,
    naam: b.naam,
    rol: b.rol,
    toelichting: b.toelichting,
    // H1d3 is de significante golfhoogte, de maat die in verwachtingen
    // gebruikt wordt. Hmax is de hoogste golf, en dat is wat er over de
    // boeg komt.
    hoogteCm: getal(m.H1d3?.value),
    maxCm: getal(m.Hmax?.value),
    richtingGraden: getal(m.Th0?.value),
    tijdstip: tijd ? tekstNaarDate(tijd)?.toISOString() || null : null,
  };
}

function leesVerwachting(bericht, b) {
  const p = bericht?.Golven_Predict?.[b.regio]?.[b.code];
  if (!p) return [];

  const uit = [];
  for (const uren of ["6", "12", "18", "24"]) {
    const v = p[uren];
    const hoogte = getal(v?.wave_height);
    if (hoogte == null) continue;
    uit.push({
      overUren: Number(uren),
      tijdstip: v.unix_date
        ? new Date(Number(v.unix_date) * 1000).toISOString()
        : tekstNaarDate(v.date)?.toISOString() || null,
      hoogteCm: Math.round(hoogte),
    });
  }
  return uit;
}

function leesWatertemp(bericht, code) {
  if (!code) return null;
  const temps = bericht?.meteo?.water_temp || {};
  const m = temps[code]?.TW10;
  const waarde = getal(m?.value);
  if (waarde == null) return null;
  return {
    station: m.name || code,
    graden: Math.round(waarde * 10) / 10,
    tijdstip: m.timestamp ? tekstNaarDate(m.timestamp)?.toISOString() || null : null,
  };
}

function leesWind(bericht, code) {
  if (!code) return null;
  const m = bericht?.meteo?.wind?.[code];
  if (!m) return null;
  // De feed geeft wind in m/s. Knopen is aan boord de gangbare eenheid.
  const ms = getal(m.WS10?.value);
  const maxMs = getal(m.WS10MXS3?.value);
  if (ms == null) return null;
  return {
    station: m.WS10?.name || code,
    richtingGraden: getal(m.WR10?.value),
    knopen: Math.round(ms * 1.94384),
    maxKnopen: maxMs == null ? null : Math.round(maxMs * 1.94384),
    tijdstip: m.WS10?.timestamp ? tekstNaarDate(m.WS10.timestamp)?.toISOString() || null : null,
  };
}

export { OPSTELLING };
