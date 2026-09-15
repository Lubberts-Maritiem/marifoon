// api/getij.js
// Haalt het astronomische getij op bij Rijkswaterstaat (WaterWebservices ddapi20)
// voor een van de vaste locaties, plus de actueel gemeten waterstand.
//
// Moet server-side, want deze RWS-API staat geen browseraanroepen toe (geen CORS).
//
// Belangrijk detail, getest 15 september 2026:
//   - Groepering GETETBRKD2 zonder Grootheid geeft het TYPE ("hoogwater"/"laagwater"),
//     met Waarde_Numeriek 0 en eenheid "dimensieloos".
//   - Diezelfde groepering MET Grootheid WATHTE en Hoedanigheid NAP geeft de HOOGTE
//     in cm NAP, op exact dezelfde tijdstippen.
//   Je hebt dus beide aanroepen nodig en koppelt ze op tijdstip.
//   - Grootheid WATHTE zonder groepering geeft de gemeten stand, per 10 minuten
//     (bij Holwerd en Delfzijl per minuut).
//   - RWS geeft tijdstippen in MET (+01:00), het hele jaar door. Dat is een correcte
//     absolute tijd, new Date() rekent dat vanzelf om naar lokale tijd.

const RWS_URL =
  "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen";

const LOCATIES = {
  denhelder: { label: "Den Helder", code: "denhelder.marsdiep" },
  denoever: { label: "Den Oever", code: "denoever.waddenzee.voorhaven" },
  texel: { label: "Texel", code: "texel.oudeschild" },
  harlingen: { label: "Harlingen", code: "harlingen.waddenzee" },
  vlieland: { label: "Vlieland", code: "vlieland.haven" },
  terschelling: { label: "West-Terschelling", code: "terschelling.west" },
  ameland: { label: "Ameland", code: "ameland.nes" },
  holwerd: { label: "Holwerd", code: "holwerd.veersteiger" },
  schiermonnikoog: { label: "Schiermonnikoog", code: "schiermonnikoog.waddenzee" },
  lauwersoog: { label: "Lauwersoog", code: "lauwersoog.waddenzee" },
  delfzijl: { label: "Delfzijl", code: "delfzijl" },
};

// In-memory cache per locatie: getij verandert traag, geen reden om
// bij elke paginaload opnieuw bij RWS te bevragen.
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
      Einddatumtijd: toRwsTijd(new Date(now + 96 * 60 * 60 * 1000)), // 4 dagen vooruit
    };
    const periodeStand = {
      Begindatumtijd: toRwsTijd(new Date(now - 2 * 60 * 60 * 1000)),
      Einddatumtijd: toRwsTijd(new Date(now)),
    };

    // Drie aanroepen parallel: type van de extremen, hoogte van de extremen,
    // en de actueel gemeten waterstand.
    const [typen, hoogtes, standen] = await Promise.all([
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
      }))
      .filter((m) => m.tijdstip && m.type)
      .sort((a, b) => new Date(a.tijdstip) - new Date(b.tijdstip));

    const toekomstig = extremen.filter((m) => new Date(m.tijdstip).getTime() >= now);
    const volgendLaagwater = toekomstig.find((m) => m.type === "laagwater") || null;
    const volgendHoogwater = toekomstig.find((m) => m.type === "hoogwater") || null;

    // Laatste geldige meting van de actuele stand.
    let actueel = null;
    for (let i = standen.length - 1; i >= 0; i--) {
      const w = standen[i]?.Meetwaarde?.Waarde_Numeriek;
      // RWS gebruikt 999999999 als "geen waarde".
      if (typeof w === "number" && Math.abs(w) < 10000 && standen[i].Tijdstip) {
        actueel = { tijdstip: standen[i].Tijdstip, waardeCm: Math.round(w) };
        break;
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
      licentie: "Bron: Rijkswaterstaat WaterWebservices (CC0), astronomisch getij.",
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
