// api/getij.js
// Getij voor de Waddenlocaties, met dezelfde cijfers als waddendata.nl.
//
// Drie bronnen:
//   1. waddendata.nl, websocket wss://data.waddendata.nl. Eén JSON-boodschap met
//      onder meer "Tides". Per locatie een lijst extremen met zowel het
//      ASTRONOMISCHE extreem (date, unix_date, water_height) als de VERWACHTING
//      van Rijkswaterstaat (date_predict, water_height_predict). Ongeveer zeven
//      dagen vooruit. Dit is de hoofdbron, want hiermee komen onze getallen op
//      de centimeter overeen met waddendata.nl.
//   2. waterinfo.rws.nl, de verwachtingsreeks per 10 minuten. Terugval voor de
//      locaties die waddendata niet voert, zoals Texel en Schiermonnikoog.
//   3. RWS WaterWebservices, het astronomische getij plus de actueel GEMETEN
//      waterstand. De gemeten stand komt altijd hiervandaan.
//
// Alles moet server-side: geen van deze bronnen staat browseraanroepen toe.
//
// Belangrijke details, getest 15 oktober 2026:
//   - waddendata geeft tijden als "2026-10-16 00:40" in Nederlandse kloktijd,
//     zonder offset. unix_date hoort bij het astronomische moment, niet bij de
//     verwachting, dus date_predict moet zelf omgerekend worden.
//   - water_height_predict komt als string binnen.
//   - Groepering GETETBRKD2 zonder Grootheid geeft het TYPE ("hoogwater" of
//     "laagwater"), met Waarde_Numeriek 0. Diezelfde groepering MET Grootheid
//     WATHTE en Hoedanigheid NAP geeft de HOOGTE in cm NAP, op exact dezelfde
//     tijdstippen. Je hebt dus beide aanroepen nodig, gekoppeld op tijdstip.
//   - Grootheid WATHTE zonder groepering geeft de gemeten stand, per 10 minuten.
//   - RWS geeft tijdstippen in MET (+01:00), het hele jaar door. Dat is een
//     correcte absolute tijd, new Date() rekent dat vanzelf om.
//   - Node 22 heeft een ingebouwde WebSocket, er is dus geen "ws"-pakket nodig.

import { haalWaddendata, tekstNaarDate, nlNaarDate } from "./_waddendata.js";

const RWS_URL =
  "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen";

const WATERINFO_URL =
  "https://waterinfo.rws.nl/api/chart/get?mapType=waterhoogte&locationCodes=";

// "code" is de RWS-locatiecode, "wadden" de sleutel in Tides van waddendata.
// Waar "wadden" ontbreekt voert waddendata die locatie niet en vallen we terug
// op de verwachtingsreeks van waterinfo.
// "code" is de RWS-locatiecode, "wadden" de sleutel in Tides van waddendata,
// "stand" het station in hun waterstandentabel: [regio, stationcode].
// Waar "wadden" ontbreekt voert waddendata geen getijtafel voor die plaats en
// vallen we terug op de verwachtingsreeks van waterinfo. De waterstandentabel
// dekt wel alle elf locaties.
const LOCATIES = {
  denhelder: { label: "Den Helder", code: "denhelder.marsdiep", wadden: "Den Helder", stand: ["west", "DENH"] },
  denoever: { label: "Den Oever", code: "denoever.waddenzee.voorhaven", stand: ["west", "OEBU"] },
  texel: { label: "Texel", code: "texel.oudeschild", stand: ["west", "OUDE"] },
  harlingen: { label: "Harlingen", code: "harlingen.waddenzee", wadden: "Harlingen", stand: ["west", "HARL"] },
  vlieland: { label: "Vlieland", code: "vlieland.haven", wadden: "Vlieland", stand: ["west", "VLIE"] },
  terschelling: { label: "West-Terschelling", code: "terschelling.west", wadden: "West-Terschelling", stand: ["west", "WTER"] },
  ameland: { label: "Ameland", code: "ameland.nes", wadden: "Nes Ameland", stand: ["west", "NESS"] },
  holwerd: { label: "Holwerd", code: "holwerd.veersteiger", wadden: "Holwerd", stand: ["oost", "HOLW"] },
  schiermonnikoog: { label: "Schiermonnikoog", code: "schiermonnikoog.waddenzee", stand: ["oost", "SCHI"] },
  lauwersoog: { label: "Lauwersoog", code: "lauwersoog.waddenzee", wadden: "Lauwersoog", stand: ["oost", "LAUW"] },
  delfzijl: { label: "Delfzijl", code: "delfzijl", wadden: "Delfzijl", stand: ["oost", "DLFZ"] },
};

// In-memory cache per locatie: getij verandert traag, geen reden om
// bij elke paginaload opnieuw bij de bronnen te bevragen.
const cache = {}; // { [locatieKey]: { data, fetchedAt } }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minuten

export default async function handler(req, res) {
  const locatieKey = (req.query?.locatie || "texel").toLowerCase();
  const locatie = LOCATIES[locatieKey];

  if (!locatie) {
    return res.status(400).json({
      error: "Onbekende locatie",
      geldigeOpties: Object.keys(LOCATIES),
    });
  }

  try {
    const now = Date.now();
    const cached = cache[locatieKey];
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.status(200).json(cached.data);
    }

    const periodeGetij = {
      Begindatumtijd: toRwsTijd(new Date(now - 12 * 60 * 60 * 1000)),
      Einddatumtijd: toRwsTijd(new Date(now + 8 * 24 * 60 * 60 * 1000)),
    };
    const periodeStand = {
      Begindatumtijd: toRwsTijd(new Date(now - 2 * 60 * 60 * 1000)),
      Einddatumtijd: toRwsTijd(new Date(now)),
    };

    // Vier aanroepen parallel: type en hoogte van de astronomische extremen,
    // de gemeten stand, en de getijtafel van waddendata.
    const [typen, hoogtes, standen, waddenTides] = await Promise.all([
      haalMetingen(locatie.code, { Groepering: { Code: "GETETBRKD2" } }, periodeGetij),
      haalMetingen(
        locatie.code,
        {
          Grootheid: { Code: "WATHTE" },
          Groepering: { Code: "GETETBRKD2" },
          Hoedanigheid: { Code: "NAP" },
        },
        periodeGetij
      ),
      haalMetingen(
        locatie.code,
        { Grootheid: { Code: "WATHTE" }, Hoedanigheid: { Code: "NAP" } },
        periodeStand
      ).catch(() => []), // gemeten stand is nice-to-have, mag falen
      haalWaddendata().catch((e) => {
        console.warn("Waddendata niet beschikbaar:", e.message);
        return null;
      }),
    ]);

    // Hoogtes per tijdstip, zodat we ze aan het juiste extreem kunnen koppelen.
    const hoogtePerTijd = new Map();
    for (const m of hoogtes) {
      const w = m.Meetwaarde?.Waarde_Numeriek;
      if (m.Tijdstip && typeof w === "number") hoogtePerTijd.set(m.Tijdstip, Math.round(w));
    }

    const extremen = typen
      .map((m) => ({
        tijdstip: m.Tijdstip,
        type: m.Meetwaarde?.Waarde_Alfanumeriek, // "hoogwater" | "laagwater"
        waardeCm: hoogtePerTijd.has(m.Tijdstip) ? hoogtePerTijd.get(m.Tijdstip) : null,
        astronomischTijdstip: m.Tijdstip,
        astronomischCm: hoogtePerTijd.has(m.Tijdstip) ? hoogtePerTijd.get(m.Tijdstip) : null,
        bron: "astronomisch",
        verschilCm: 0,
      }))
      .filter((m) => m.tijdstip && m.type)
      .sort((a, b) => new Date(a.tijdstip) - new Date(b.tijdstip));

    // De verwachting eroverheen leggen. Waddendata heeft voorrang, want dat is
    // de bron waar de cijfers mee moeten overeenkomen.
    let bronNaam = "astronomisch";
    const waddenExtremen =
      waddenTides && locatie.wadden ? leesWaddenExtremen(waddenTides.Tides, locatie.wadden) : [];

    if (waddenExtremen.length) {
      voegVerwachtingSamen(extremen, waddenExtremen);
      vulAanMetWadden(extremen, waddenExtremen);
      bronNaam = "waddendata";
    } else {
      const uitWaterinfo = await haalWaterinfoVerwachting(locatie.code).catch((e) => {
        console.warn("Waterinfo-verwachting niet beschikbaar:", e.message);
        return [];
      });
      if (uitWaterinfo.length) {
        voegVerwachtingSamen(extremen, uitWaterinfo);
        bronNaam = "waterinfo";
      }
    }

    const toekomstig = extremen.filter((m) => new Date(m.tijdstip).getTime() >= now);
    const volgendLaagwater = toekomstig.find((m) => m.type === "laagwater") || null;
    const volgendHoogwater = toekomstig.find((m) => m.type === "hoogwater") || null;

    // Actuele stand. Waddendata eerst, zodat het getal op het scherm hetzelfde
    // is als in hun waterstandentabel. Staat daar niets, dan de meting van RWS.
    let actueel = leesWaddenStand(waddenTides, locatie.stand);

    if (!actueel) {
      for (let i = standen.length - 1; i >= 0; i--) {
        const w = standen[i]?.Meetwaarde?.Waarde_Numeriek;
        // RWS gebruikt 999999999 als "geen waarde".
        if (typeof w === "number" && Math.abs(w) < 10000 && standen[i].Tijdstip) {
          actueel = {
            tijdstip: standen[i].Tijdstip,
            waardeCm: Math.round(w),
            astronomischCm: null,
            afwijkingCm: null,
            bron: "rws",
          };
          break;
        }
      }
    }

    const result = {
      locatie: locatie.label,
      locatieKey,
      opgehaaldOp: new Date().toISOString(),
      extremen,
      volgendLaagwater,
      volgendHoogwater,
      actueel,
      bronNaam,
      // Hoeveel van de getoonde extremen uit de verwachting komen. Handig om
      // in de interface te melden welke bron er nu eigenlijk op het scherm staat.
      bron: {
        verwacht: extremen.filter((e) => e.bron === "verwacht").length,
        astronomisch: extremen.filter((e) => e.bron === "astronomisch").length,
      },
      licentie:
        bronNaam === "waddendata"
          ? "Getij: waddendata.nl (data Rijkswaterstaat). Actuele stand: RWS WaterWebservices (CC0)."
          : "Bron: Rijkswaterstaat (WaterWebservices en Waterinfo).",
    };

    cache[locatieKey] = { data: result, fetchedAt: now };
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).json(result);
  } catch (err) {
    console.error("Getij-ophalen mislukt:", err);
    return res.status(502).json({
      error: "Kon getijgegevens niet ophalen",
      detail: String(err.message || err),
    });
  }
}

// ── Waddendata ───────────────────────────────────────────────────────────────

function leesWaddenExtremen(tides, waddenKey) {
  // Tides[locatie] is [ [regiocode, stationcode], [ extreem, extreem, ... ] ].
  const lijst = tides?.[waddenKey]?.[1];
  if (!Array.isArray(lijst)) return [];

  const uit = [];
  for (const e of lijst) {
    if (!e?.date_predict || e.water_height_predict == null || e.water_height_predict === "") continue;

    const waarde = Number(e.water_height_predict);
    if (!Number.isFinite(waarde)) continue;

    const moment = tekstNaarDate(e.date_predict);
    if (!moment) continue;

    uit.push({
      tijdstipMs: moment.getTime(),
      type: e.tide === "HW" ? "hoogwater" : "laagwater",
      waardeCm: Math.round(waarde),
      // Het astronomische extreem dat waddendata er zelf bij geeft, zodat we
      // ook kunnen tonen hoeveel opzet erin zit als RWS die rij niet levert.
      astroMs: e.unix_date ? Number(e.unix_date) * 1000 : null,
      astroCm: typeof e.water_height === "number" ? Math.round(e.water_height) : null,
    });
  }
  return uit.sort((a, b) => a.tijdstipMs - b.tijdstipMs);
}

function leesWaddenStand(bericht, stand) {
  // waterstanden[regio][station].H1 is de gemeten stand, met daarnaast
  // WaterstandenAstroPredict[regio][station] de astronomische waarde op datzelfde
  // moment. Het verschil tussen die twee is de opzet, de kolom "afw" op hun site.
  if (!bericht || !stand) return null;
  const [regio, code] = stand;

  const h1 = bericht.waterstanden?.[regio]?.[code]?.H1;
  if (!h1) return null;

  // Een station zonder meting geeft "--" terug in plaats van een getal.
  const waarde = Number(h1.value);
  if (h1.value === "--" || h1.value == null || !Number.isFinite(waarde)) return null;

  const astroRuw = bericht.WaterstandenAstroPredict?.[regio]?.[code]?.value;
  const astro = Number(astroRuw);
  const astronomischCm = Number.isFinite(astro) && astroRuw !== "--" ? Math.round(astro) : null;

  const tijdstip = h1.unix_timestamp
    ? new Date(Number(h1.unix_timestamp) * 1000).toISOString()
    : tekstNaarDate(h1.timestamp)?.toISOString() || null;
  if (!tijdstip) return null;

  return {
    tijdstip,
    waardeCm: Math.round(waarde),
    astronomischCm,
    afwijkingCm: astronomischCm == null ? null : Math.round(waarde) - astronomischCm,
    bron: "waddendata",
  };
}

function vulAanMetWadden(extremen, verwacht) {
  // Waddendata kijkt ongeveer zeven dagen vooruit, RWS levert hier acht dagen
  // astronomische extremen. Mocht er toch een verwacht extreem zijn waar geen
  // astronomische rij bij hoort, dan voegen we die alsnog toe, zodat de tabel
  // niet onnodig gaten krijgt.
  const bezet = new Set(
    extremen.filter((e) => e.bron === "verwacht").map((e) => new Date(e.tijdstip).getTime())
  );

  for (const v of verwacht) {
    if (bezet.has(v.tijdstipMs)) continue;
    extremen.push({
      tijdstip: new Date(v.tijdstipMs).toISOString(),
      type: v.type,
      waardeCm: v.waardeCm,
      astronomischTijdstip: v.astroMs ? new Date(v.astroMs).toISOString() : null,
      astronomischCm: v.astroCm,
      bron: "verwacht",
      verschilCm: v.astroCm == null ? null : v.waardeCm - v.astroCm,
    });
  }
  extremen.sort((a, b) => new Date(a.tijdstip) - new Date(b.tijdstip));
}

// ── Waterinfo, terugval voor locaties zonder waddendata ──────────────────────

async function haalWaterinfoVerwachting(code) {
  // Deze endpoint accepteert alleen vaste vensters. "-48,48" werkt, "-24,24"
  // niet. Het einde ligt hoe dan ook op de horizon van het model, ongeveer
  // 48 uur vooruit.
  const res = await fetch(WATERINFO_URL + encodeURIComponent(code) + "&values=-48,48", {
    headers: { "User-Agent": "wadoversteken.nl getij-widget (contact via wadoversteken.nl)" },
  });
  if (!res.ok) throw new Error(`waterinfo gaf status ${res.status}`);

  const csv = await res.text();
  const regels = csv.split("\n");
  const kop = (regels.shift() || "").split(";");

  // De kop belooft negen kolommen, drie reeksen met elk een "Extremen"-kolom,
  // maar die extremenkolommen komen altijd leeg terug en ontbreken in de
  // datarijen. Daarom zoeken we de kolom op naam in plaats van op positie.
  let kolom = -1;
  let teller = 0;
  for (const naam of kop) {
    const n = naam.toLowerCase();
    if (n.startsWith("extremen")) continue;
    if (n.includes("verwachting")) { kolom = teller; break; }
    teller++;
  }
  if (kolom === -1) throw new Error("kolom verwachting niet gevonden in de CSV-kop");

  const reeks = [];
  for (const regel of regels) {
    const k = regel.trim().split(";");
    if (k.length <= kolom || !k[kolom]) continue;
    const [dd, mm, jjjj] = k[0].split("-").map(Number);
    const [uu, min] = k[1].split(":").map(Number);
    if (!jjjj || Number.isNaN(uu)) continue;
    reeks.push({ tijd: nlNaarDate(jjjj, mm, dd, uu, min), waarde: Number(k[kolom]) });
  }
  if (reeks.length < 5) return [];

  return zoekExtremen(reeks);
}

function zoekExtremen(reeks) {
  // De reeks staat per 10 minuten. Een punt is een extreem als het over een uur
  // aan weerszijden het hoogste of laagste is. Aan de randen van de reeks korten
  // we dat venster eenzijdig in, want de verwachting begint pas rond het huidige
  // moment en juist het eerstvolgende extreem is het belangrijkste.
  const VENSTER = 6; // 6 punten is 60 minuten
  const RAND = 2;
  const uit = [];

  for (let i = RAND; i < reeks.length - RAND; i++) {
    const van = Math.max(0, i - VENSTER);
    const tot = Math.min(reeks.length - 1, i + VENSTER);
    const v = reeks[i].waarde;
    let hoogste = true;
    let laagste = true;
    for (let j = van; j <= tot; j++) {
      if (j === i) continue;
      if (reeks[j].waarde > v) hoogste = false;
      if (reeks[j].waarde < v) laagste = false;
    }
    if (!hoogste && !laagste) continue;
    if (uit.length && reeks[i].tijd - uit[uit.length - 1].tijdstipMs < 3 * 60 * 60 * 1000) continue;

    // Het moment verfijnen met een parabool door de drie punten rond de top,
    // zodat we niet aan het raster van 10 minuten vastzitten.
    const y0 = reeks[i - 1].waarde;
    const y1 = v;
    const y2 = reeks[i + 1].waarde;
    const noemer = y0 - 2 * y1 + y2;
    let delta = noemer === 0 ? 0 : (0.5 * (y0 - y2)) / noemer;
    if (!Number.isFinite(delta) || Math.abs(delta) > 0.5) delta = 0;

    uit.push({
      tijdstipMs: reeks[i].tijd.getTime() + delta * 10 * 60 * 1000,
      type: hoogste ? "hoogwater" : "laagwater",
      waardeCm: Math.round(y1 - 0.25 * (y0 - y2) * delta),
    });
  }
  return uit;
}

// ── Samenvoegen ──────────────────────────────────────────────────────────────

function voegVerwachtingSamen(extremen, verwacht) {
  // Een astronomisch extreem en het bijbehorende verwachte extreem liggen dicht
  // bij elkaar. Opzet verschuift het moment hooguit een klein uur, dus zoeken we
  // binnen 90 minuten naar de dichtstbijzijnde van hetzelfde type.
  const MARGE_MS = 90 * 60 * 1000;

  for (const e of extremen) {
    const doel = new Date(e.tijdstip).getTime();
    let beste = null;
    let besteAfstand = MARGE_MS;

    for (const v of verwacht) {
      if (v.type !== e.type) continue;
      const afstand = Math.abs(v.tijdstipMs - doel);
      if (afstand < besteAfstand) {
        besteAfstand = afstand;
        beste = v;
      }
    }
    if (!beste) continue;

    e.tijdstip = new Date(beste.tijdstipMs).toISOString();
    e.waardeCm = beste.waardeCm;
    e.bron = "verwacht";
    e.verschilCm = e.astronomischCm == null ? null : beste.waardeCm - e.astronomischCm;
  }
  extremen.sort((a, b) => new Date(a.tijdstip) - new Date(b.tijdstip));
}

// ── RWS ──────────────────────────────────────────────────────────────────────

async function haalMetingen(code, aquoMetadata, periode) {
  const response = await fetch(RWS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Locatie: { Code: code },
      AquoPlusWaarnemingMetadata: { AquoMetadata: aquoMetadata },
      Periode: periode,
    }),
  });

  // 204 betekent: verzoek klopt, maar er is geen data voor deze combinatie.
  if (response.status === 204) return [];
  if (!response.ok) throw new Error(`RWS gaf status ${response.status}`);

  const tekst = await response.text();
  if (!tekst) return [];
  const json = JSON.parse(tekst);
  return json?.WaarnemingenLijst?.[0]?.MetingenLijst || [];
}

function toRwsTijd(date) {
  // RWS accepteert gewoon UTC met een "+00:00"-suffix en rekent zelf om.
  return date.toISOString().replace("Z", "+00:00");
}

export { LOCATIES };
