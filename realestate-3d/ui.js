// Page UI that works with or without WebGL: card reveals, elevator floor
// counter, progress bar, the apartment picker and the lead form.
import { UNITS, STATUS_LABEL, formatPrice, saveLead } from "./data.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* ---------- reveal cards as their stage scrolls in ---------- */
const io = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.target.classList.toggle("is-visible", e.isIntersecting)),
  { threshold: 0.25 }
);
$$(".card").forEach((c) => io.observe(c));

/* ---------- extra details: open on desktop, tap-to-open on phones ---------- */
const wide = matchMedia("(min-width: 761px)");
const syncDetails = () => $$(".stage details.more").forEach((d) => (d.open = wide.matches));
syncDetails();
wide.addEventListener("change", syncDetails);

/* ---------- chapter dots: jump to any stage of the tour ---------- */
const chapters = $("#chapters");
const stages = $$(".stage");
stages.forEach((st, i) => {
  const b = document.createElement("button");
  b.type = "button";
  b.innerHTML = `<span>${st.dataset.title}</span>`;
  b.setAttribute("aria-label", st.dataset.title);
  b.addEventListener("click", () => {
    const y = i === 0 ? 0 : st.offsetTop + st.offsetHeight / 2 - innerHeight / 2;
    scrollTo({ top: y, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  chapters.append(b);
});

/* ---------- progress bar + elevator floor counter ---------- */
const journey = $("#journey");
const bar = $("#progress-bar");
const elevatorStage = $('.stage[data-stage="3"]');
const floorNum = $("#floor-num");
const topbar = $(".topbar");

function onScroll() {
  const vh = innerHeight;
  const total = journey.offsetHeight - vh;
  bar.style.transform = `scaleX(${clamp01(scrollY / total)})`;

  // highlight the chapter whose card is nearest the middle of the screen
  let active = -1, best = Infinity;
  stages.forEach((st, i) => {
    const r = st.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - vh / 2);
    if (d < best && r.bottom > 0 && r.top < vh) (best = d), (active = i);
  });
  [...chapters.children].forEach((b, i) => b.classList.toggle("is-active", i === active));
  const pastTour = journey.getBoundingClientRect().bottom < vh * 0.5;
  chapters.classList.toggle("is-hidden", pastTour);
  topbar.classList.toggle("is-solid", journey.getBoundingClientRect().bottom < 70);

  // count floors 1 → 9 while the elevator stage passes the middle of the screen
  const r = elevatorStage.getBoundingClientRect();
  const t = clamp01((vh - r.top) / (r.height + vh * 0.2));
  floorNum.textContent = String(1 + Math.round(t * 8));
}
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll);
onScroll();

/* ---------- "from" prices on the balcony card, straight from the inventory ---------- */
const priceRows = $("#price-rows");
for (const rooms of [3, 4, 5, 6]) {
  const units = UNITS.filter((u) => u.rooms === rooms);
  const areas = [...new Set(units.map((u) => u.area))].sort((a, b) => a - b);
  const from = Math.min(...units.filter((u) => u.status !== "sold").map((u) => u.price));
  const tr = priceRows.insertRow();
  tr.innerHTML = `<td>${rooms === 6 ? "פנטהאוז" : rooms + " חדרים"}</td><td>${areas.join("–")} מ״ר</td><td>${Number.isFinite(from) ? formatPrice(from) : "אזל"}</td>`;
}

/* ---------- apartment picker ---------- */
const tower = $("#tower");
const unitCard = $("#unit");
const unitSelect = $("#unit-select");
let selectedId = null;

for (let floor = 12; floor >= 1; floor--) {
  const row = document.createElement("div");
  row.className = "floor";
  row.innerHTML = `<span class="floor__num">${floor}</span>`;
  for (const u of UNITS.filter((x) => x.floor === floor)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `cell cell--${u.status}${u.rooms === 6 ? " cell--wide" : ""}`;
    b.dataset.id = u.id;
    b.dataset.rooms = u.rooms;
    b.textContent = u.rooms === 6 ? "PH" : u.rooms;
    b.setAttribute("aria-label", `דירה ${u.id}, קומה ${u.floor}, ${u.rooms} חדרים, ${STATUS_LABEL[u.status]}`);
    row.append(b);
  }
  tower.append(row);
}

for (const u of UNITS.filter((x) => x.status !== "sold")) {
  unitSelect.add(new Option(`דירה ${u.id} · קומה ${u.floor} · ${u.rooms === 6 ? "פנטהאוז" : u.rooms + " חדרים"}`, u.id));
}

tower.addEventListener("click", (e) => {
  const cell = e.target.closest(".cell");
  if (cell) showUnit(cell.dataset.id);
});

function showUnit(id) {
  const u = UNITS.find((x) => x.id === id);
  selectedId = id;
  $$(".cell", tower).forEach((c) => c.classList.toggle("is-selected", c.dataset.id === id));
  const color = { free: "var(--free)", hold: "var(--hold)", sold: "#4a5263" }[u.status];
  unitCard.innerHTML = `
    <span class="status" style="background:${color}">${STATUS_LABEL[u.status]}</span>
    <h3>דירה ${u.id} · ${u.model}</h3>
    <p>קומה ${u.floor} · ${u.rooms === 6 ? "פנטהאוז 6 חדרים" : u.rooms + " חדרים"}</p>
    <dl>
      <div><dt>שטח</dt><dd>${u.area} מ״ר</dd></div>
      <div><dt>מרפסת</dt><dd>${u.balcony} מ״ר</dd></div>
      <div><dt>כיווני אוויר</dt><dd>${u.aspect}</dd></div>
      <div><dt>חניות</dt><dd>${u.parking}</dd></div>
    </dl>
    <p class="price">${u.status === "sold" ? "נמכרה" : formatPrice(u.price)}</p>
    ${u.status === "sold" ? "" : '<a class="btn" href="#contact" id="book-unit">קבעו פגישה לדירה זו</a>'}
  `;
  if (!wide.matches) unitCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const book = $("#book-unit", unitCard);
  if (book) book.addEventListener("click", () => (unitSelect.value = id));
}

$$(".filter").forEach((btn) =>
  btn.addEventListener("click", () => {
    $$(".filter").forEach((b) => b.classList.toggle("is-active", b === btn));
    const want = btn.dataset.rooms;
    $$(".cell", tower).forEach((c) => c.classList.toggle("is-dim", want !== "all" && c.dataset.rooms !== want));
  })
);

/* ---------- lead form ---------- */
const form = $("#lead-form");
const err = $("#form-error");

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const phone = data.phone.replace(/[\s-]/g, "");
  if (data.name.trim().length < 2) return (err.textContent = "נא למלא שם מלא.");
  if (!/^0\d{8,9}$/.test(phone)) return (err.textContent = "נא למלא מספר טלפון תקין.");
  if (data.email && !form.email.checkValidity()) return (err.textContent = "כתובת האימייל לא תקינה.");
  err.textContent = "";

  // No backend yet: leads are kept in this browser and listed on leads.html.
  // Swap saveLead() for a fetch() to your CRM / server when going live.
  saveLead({ ...data, phone, unit: data.unit || selectedId || "" });
  form.hidden = true;
  $("#form-done").hidden = false;
});
