// Demo inventory for the project: 12 floors × 4 apartments (2 penthouses on top).
// Replace with real data from the sales team / an API when going live.

// small seeded RNG so the "sold" pattern is the same on every visit
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS = [
  { model: "דגם C", rooms: 3, area: 86, balcony: 10, aspect: 2 },
  { model: "דגם B", rooms: 4, area: 108, balcony: 12, aspect: 2 },
  { model: "דגם A", rooms: 5, area: 132, balcony: 14, aspect: 3 },
  { model: "דגם B+", rooms: 4, area: 112, balcony: 12, aspect: 3 },
];
const PENTHOUSE = { model: "פנטהאוז", rooms: 6, area: 210, balcony: 65, aspect: 4 };
const PRICE_PER_M2 = 33000;

const rand = rng(9);
export const UNITS = [];
for (let floor = 1; floor <= 12; floor++) {
  const models = floor === 12 ? [PENTHOUSE, PENTHOUSE] : MODELS;
  models.forEach((m, i) => {
    const r = rand();
    // higher floors sell first, like in real projects
    let status = r < 0.22 + floor * 0.025 ? "sold" : r < 0.36 + floor * 0.02 ? "hold" : "free";
    if (floor === 12) status = i === 0 ? "sold" : "free"; // one penthouse left
    const premium = 1 + floor * 0.012;
    const price = Math.round((m.area * PRICE_PER_M2 * premium) / 10000) * 10000;
    UNITS.push({
      id: String(floor * 100 + i + 1),
      floor,
      ...m,
      parking: m.rooms >= 5 ? 2 : 1,
      price: m === PENTHOUSE ? Math.round((price * 1.25) / 10000) * 10000 : price,
      status,
    });
  });
}

export const STATUS_LABEL = { free: "פנויה", hold: "בשריון", sold: "נמכרה" };

export const formatPrice = (n) => "₪" + Math.round(n).toLocaleString("he-IL");

const KEY = "ofek-leads";

export function loadLeads() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

export function saveLead(lead) {
  const all = loadLeads();
  all.unshift({ ...lead, at: new Date().toISOString(), done: false });
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode / storage full — the visitor still sees the thank-you */
  }
}

export function writeLeads(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {}
}
