/* ============================================================
   sole&luna — "מגדל השמירה" (Watchtower)
   24/7 health + business monitoring: builds the report shown on
   the live dashboard and mailed every 12h. No extra npm deps.
   ============================================================ */

const HOUR = 3600_000;

function shekel(n) { return "₪" + Number(n || 0).toLocaleString("he-IL"); }
function ok(label, note) { return { label, status: "ok", note }; }
function warn(label, note) { return { label, status: "warn", note }; }
function fail(label, note) { return { label, status: "fail", note }; }

/* ---- health / security self-checks (run live and in the report) ---- */
function runSelfChecks(db, ctx) {
  const checks = [];

  try {
    db.prepare("SELECT 1").get();
    checks.push(ok("מסד נתונים", "מגיב לשאילתות"));
  } catch (e) {
    checks.push(fail("מסד נתונים", "לא מגיב: " + e.message));
  }

  try {
    const n = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
    checks.push(n > 0 ? ok("קטלוג", n + " מוצרים טעונים")
                      : fail("קטלוג", "אין מוצרים בקטלוג"));
  } catch (e) {
    checks.push(fail("קטלוג", e.message));
  }

  try {
    const fs = require("fs"), path = require("path");
    const probe = path.join(ctx.dataDir, ".write-probe");
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    checks.push(ok("אחסון", "הדיסק ניתן לכתיבה"));
  } catch (e) {
    checks.push(fail("אחסון", "בעיית כתיבה לדיסק: " + e.message));
  }

  checks.push(ctx.paymentsConfigured
    ? ok("תשלומים", "Grow מחובר ופעיל")
    : warn("תשלומים", "מצב דמו — מפתחות Grow לא הוגדרו (אין חיוב אמיתי)"));

  if (ctx.isProduction && ctx.allowDemoCheckout) {
    checks.push(warn("אבטחת תשלום", "ALLOW_DEMO_CHECKOUT דלוק בפרודקשן — לכבות לפני מכירות אמת"));
  }

  const errors24 = db.prepare(
    "SELECT COUNT(*) AS n FROM system_events WHERE type = 'error' AND created_at >= ?"
  ).get(Date.now() - 24 * HOUR).n;
  checks.push(errors24 === 0
    ? ok("יציבות קוד", "אין שגיאות שרת ב-24 השעות האחרונות")
    : warn("יציבות קוד", errors24 + " שגיאות שרת נרשמו ב-24 השעות האחרונות"));

  return checks;
}

/* ---- full business + health report ---- */
function buildReport(db, ctx) {
  const now = Date.now();
  const windowMs = (ctx.windowHours || 12) * HOUR;
  const since = now - windowMs;
  const lowThreshold = ctx.lowStockThreshold != null ? ctx.lowStockThreshold : 3;

  const paidWin = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS rev FROM orders WHERE status='paid' AND paid_at >= ?"
  ).get(since);
  const paidAll = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS rev FROM orders WHERE status='paid'"
  ).get();
  const itemsWin = db.prepare(
    "SELECT COALESCE(SUM(oi.qty),0) AS q FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status='paid' AND o.paid_at >= ?"
  ).get(since).q;
  const itemsAll = db.prepare(
    "SELECT COALESCE(SUM(oi.qty),0) AS q FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status='paid'"
  ).get().q;
  const topSold = db.prepare(`
    SELECT oi.product_id, p.name, SUM(oi.qty) AS qty
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.status='paid' AND o.paid_at >= ?
    GROUP BY oi.product_id ORDER BY qty DESC LIMIT 6
  `).all(since);

  const unitsInStock = db.prepare("SELECT COALESCE(SUM(stock),0) AS n FROM inventory").get().n;
  const lowStock = db.prepare(`
    SELECT p.name, i.product_id, i.color_name, i.size, i.stock
    FROM inventory i JOIN products p ON p.id = i.product_id
    WHERE i.stock > 0 AND i.stock <= ?
    ORDER BY i.stock ASC, p.name LIMIT 25
  `).all(lowThreshold);
  const soldOut = db.prepare(`
    SELECT p.name, i.product_id, i.color_name, i.size
    FROM inventory i JOIN products p ON p.id = i.product_id
    WHERE i.stock <= 0 ORDER BY p.name LIMIT 40
  `).all();

  // Shipments = paid orders not yet marked shipped
  const pendingShip = db.prepare(`
    SELECT order_num, email, total, paid_at,
           (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS lines,
           (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = o.id) AS units
    FROM orders o WHERE status='paid' AND shipped_at IS NULL
    ORDER BY paid_at ASC
  `).all();
  const shippedWin = db.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE shipped_at IS NOT NULL AND shipped_at >= ?"
  ).get(since).n;

  const usersTotal = db.prepare("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL").get().n;
  const usersNew = db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND created_at >= ?"
  ).get(since).n;
  const usersExisting = Math.max(0, usersTotal - usersNew);
  const deletedWin = db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NOT NULL AND deleted_at >= ?"
  ).get(since).n;
  const deletedAll = db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NOT NULL"
  ).get().n;
  const clubTotal = db.prepare("SELECT COUNT(*) AS n FROM newsletter_subscribers").get().n;
  const clubNew = db.prepare(
    "SELECT COUNT(*) AS n FROM newsletter_subscribers WHERE created_at >= ?"
  ).get(since).n;

  const errorsWin = db.prepare(
    "SELECT COUNT(*) AS n FROM system_events WHERE type='error' AND created_at >= ?"
  ).get(since).n;
  const lastErrors = db.prepare(
    "SELECT detail, created_at FROM system_events WHERE type='error' ORDER BY created_at DESC LIMIT 5"
  ).all();

  const checks = runSelfChecks(db, ctx);
  const worst = checks.some((c) => c.status === "fail") ? "fail"
              : checks.some((c) => c.status === "warn") ? "warn" : "ok";

  return {
    generatedAt: now,
    windowHours: ctx.windowHours || 12,
    overall: worst,
    uptimeSeconds: ctx.startedAt ? Math.floor((now - ctx.startedAt) / 1000) : null,
    checks,
    purchases: {
      ordersWindow: paidWin.n, revenueWindow: paidWin.rev,
      ordersAll: paidAll.n, revenueAll: paidAll.rev,
      itemsWindow: itemsWin, itemsAll: itemsAll,
      topSold,
    },
    inventory: { unitsInStock, low: lowStock, soldOut },
    shipments: { pending: pendingShip, pendingCount: pendingShip.length, shippedWindow: shippedWin },
    users: {
      total: usersTotal, newWindow: usersNew, existing: usersExisting,
      deletedWindow: deletedWin, deletedAll,
      clubTotal, clubNew,
    },
    health: { errorsWindow: errorsWin, lastErrors },
  };
}

/* ---- email rendering ---- */
function statusWord(s) { return s === "ok" ? "תקין ✓" : s === "warn" ? "לתשומת לב ⚠" : "תקלה ✗"; }
function fmtTime(ts) { return new Date(ts).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" }); }
function uptimeStr(sec) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return (d ? d + " ימים " : "") + h + " שעות " + m + " דקות";
}

function renderReportText(r) {
  const L = [];
  L.push(`sole&luna · דו״ח מגדל השמירה`);
  L.push(`מצב כללי: ${statusWord(r.overall)}`);
  L.push(`נוצר: ${fmtTime(r.generatedAt)} · חלון: ${r.windowHours} שעות אחרונות`);
  L.push(`זמן פעילות רצוף: ${uptimeStr(r.uptimeSeconds)}`);
  L.push("");
  L.push("— בריאות ואבטחה —");
  for (const c of r.checks) L.push(`  ${statusWord(c.status)}  ${c.label}: ${c.note}`);
  if (r.health.errorsWindow) {
    L.push(`  שגיאות בחלון: ${r.health.errorsWindow}`);
    for (const e of r.health.lastErrors) L.push(`    · ${fmtTime(e.created_at)} — ${e.detail || ""}`);
  }
  L.push("");
  L.push("— רכישות —");
  L.push(`  בחלון: ${r.purchases.ordersWindow} הזמנות · ${r.purchases.itemsWindow} פריטים · ${shekel(r.purchases.revenueWindow)}`);
  L.push(`  מצטבר: ${r.purchases.ordersAll} הזמנות · ${r.purchases.itemsAll} פריטים · ${shekel(r.purchases.revenueAll)}`);
  if (r.purchases.topSold.length) {
    L.push("  הנמכרים ביותר בחלון:");
    for (const t of r.purchases.topSold) L.push(`    · ${t.name || t.product_id} — ${t.qty} יח׳`);
  }
  L.push("");
  L.push("— מלאי —");
  L.push(`  סה״כ יחידות במלאי: ${r.inventory.unitsInStock}`);
  L.push(`  פריטים במלאי נמוך: ${r.inventory.low.length} · אזלו לגמרי: ${r.inventory.soldOut.length}`);
  for (const i of r.inventory.low) L.push(`    ⚠ ${i.name} (${i.color_name} / ${i.size}) — נותרו ${i.stock}`);
  for (const i of r.inventory.soldOut) L.push(`    ✗ אזל: ${i.name} (${i.color_name} / ${i.size})`);
  L.push("");
  L.push("— משלוחים —");
  L.push(`  ממתינים למשלוח: ${r.shipments.pendingCount} · נשלחו בחלון: ${r.shipments.shippedWindow}`);
  for (const s of r.shipments.pending) {
    L.push(`    → ${s.order_num} · ${s.email || "ללא מייל"} · ${s.units} פריטים · ${shekel(s.total)} · שולם ${fmtTime(s.paid_at)}`);
  }
  L.push("");
  L.push("— משתמשים —");
  L.push(`  לקוחות רשומים: ${r.users.total} (חדשים בחלון: ${r.users.newWindow}, קיימים: ${r.users.existing})`);
  L.push(`  מחקו חשבון: ${r.users.deletedWindow} בחלון · ${r.users.deletedAll} מצטבר`);
  L.push(`  חברי מועדון (ניוזלטר): ${r.users.clubTotal} (חדשים בחלון: ${r.users.clubNew})`);
  L.push("");
  L.push("— מגדל השמירה של sole&luna · אוטומטי —");
  return L.join("\n");
}

function badge(s) {
  const c = s === "ok" ? "#2f7d52" : s === "warn" ? "#b8860b" : "#b3261e";
  const bg = s === "ok" ? "#e8f3ec" : s === "warn" ? "#fbf2df" : "#fbe7e5";
  return `background:${bg};color:${c};padding:2px 10px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap`;
}

function renderReportHtml(r) {
  const row = (label, value) =>
    `<tr><td style="padding:6px 0;color:#5a6b5e">${label}</td><td style="padding:6px 0;text-align:end;font-weight:600;color:#1e2a22">${value}</td></tr>`;
  const section = (title, inner) =>
    `<h3 style="font:600 15px/1.3 system-ui,Arial;margin:26px 0 8px;color:#23423a;border-bottom:1px solid #e6e9e2;padding-bottom:6px">${title}</h3>${inner}`;

  const checksHtml = r.checks.map((c) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:7px 0;border-bottom:1px solid #f0f2ec">
       <span style="color:#1e2a22">${c.label} — <span style="color:#5a6b5e">${c.note}</span></span>
       <span style="${badge(c.status)}">${statusWord(c.status)}</span></div>`).join("");

  const lowHtml = r.inventory.low.length
    ? r.inventory.low.map((i) => `<div style="padding:4px 0;color:#8a6d1a">⚠ ${i.name} (${i.color_name} / ${i.size}) — נותרו ${i.stock}</div>`).join("")
    : `<div style="color:#5a6b5e">כל הפריטים במלאי תקין 👍</div>`;
  const soldOutHtml = r.inventory.soldOut.length
    ? r.inventory.soldOut.map((i) => `<div style="padding:4px 0;color:#b3261e">✗ אזל: ${i.name} (${i.color_name} / ${i.size})</div>`).join("")
    : "";
  const shipHtml = r.shipments.pending.length
    ? `<table style="width:100%;border-collapse:collapse;font:13px system-ui,Arial">
        <tr style="color:#5a6b5e;text-align:start"><th style="text-align:start;padding:4px 0">הזמנה</th><th style="text-align:start">לקוח</th><th style="text-align:start">פריטים</th><th style="text-align:end">סכום</th></tr>
        ${r.shipments.pending.map((s) => `<tr style="border-top:1px solid #f0f2ec"><td style="padding:6px 0;font-weight:600">${s.order_num}</td><td>${s.email || "—"}</td><td>${s.units}</td><td style="text-align:end">${shekel(s.total)}</td></tr>`).join("")}
       </table>`
    : `<div style="color:#5a6b5e">אין משלוחים ממתינים 🎉</div>`;
  const topHtml = r.purchases.topSold.length
    ? r.purchases.topSold.map((t) => `<div style="padding:3px 0;color:#1e2a22">· ${t.name || t.product_id} — <b>${t.qty}</b> יח׳</div>`).join("")
    : `<div style="color:#5a6b5e">אין מכירות בחלון הזמן הזה</div>`;
  const errHtml = r.health.errorsWindow
    ? `<div style="margin-top:8px;color:#b3261e">${r.health.errorsWindow} שגיאות שרת בחלון:</div>` +
      r.health.lastErrors.map((e) => `<div style="font:12px monospace;color:#7a2b26;padding:2px 0">${fmtTime(e.created_at)} — ${(e.detail || "").replace(/</g, "&lt;")}</div>`).join("")
    : "";

  return `<div style="max-width:640px;margin:0 auto;font:14px/1.55 system-ui,Arial;color:#1e2a22;direction:rtl;text-align:right;background:#faf9f5;padding:24px;border-radius:10px">
    <div style="text-align:center;margin-bottom:6px">
      <div style="font:600 22px/1 Georgia,serif;letter-spacing:.5px">sole&luna</div>
      <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#8a9a86;margin-top:4px">מגדל השמירה · דו״ח ${r.windowHours} שעות</div>
    </div>
    <div style="text-align:center;margin:14px 0">
      <span style="${badge(r.overall)};font-size:14px;padding:6px 16px">מצב כללי: ${statusWord(r.overall)}</span>
    </div>
    <div style="text-align:center;color:#8a9a86;font-size:12px">${fmtTime(r.generatedAt)} · זמן פעילות ${uptimeStr(r.uptimeSeconds)}</div>

    ${section("בריאות ואבטחה", checksHtml + errHtml)}
    ${section("רכישות", `<table style="width:100%;border-collapse:collapse">
      ${row("הזמנות בחלון", r.purchases.ordersWindow + " · " + r.purchases.itemsWindow + " פריטים")}
      ${row("הכנסה בחלון", shekel(r.purchases.revenueWindow))}
      ${row("סה״כ הזמנות (מצטבר)", r.purchases.ordersAll)}
      ${row("סה״כ הכנסה (מצטבר)", shekel(r.purchases.revenueAll))}
    </table><div style="margin-top:8px">${topHtml}</div>`)}
    ${section("מלאי", `<table style="width:100%;border-collapse:collapse">
      ${row("יחידות במלאי", r.inventory.unitsInStock)}
      ${row("במלאי נמוך", r.inventory.low.length)}
      ${row("אזלו לגמרי", r.inventory.soldOut.length)}
    </table><div style="margin-top:8px">${lowHtml}${soldOutHtml}</div>`)}
    ${section("משלוחים לביצוע", `<div style="margin-bottom:8px;color:#1e2a22">עליך לבצע <b>${r.shipments.pendingCount}</b> משלוחים · נשלחו בחלון: ${r.shipments.shippedWindow}</div>${shipHtml}`)}
    ${section("משתמשים", `<table style="width:100%;border-collapse:collapse">
      ${row("לקוחות רשומים", r.users.total)}
      ${row("חדשים בחלון", r.users.newWindow)}
      ${row("לקוחות קיימים", r.users.existing)}
      ${row("מחקו חשבון (בחלון / מצטבר)", r.users.deletedWindow + " / " + r.users.deletedAll)}
      ${row("חברי מועדון", r.users.clubTotal + " (חדשים: " + r.users.clubNew + ")")}
    </table>`)}

    <div style="text-align:center;margin-top:26px;color:#8a9a86;font-size:11px">נשלח אוטומטית ע״י מגדל השמירה של sole&luna</div>
  </div>`;
}

function renderReportEmail(r) {
  return {
    subject: `sole&luna · דו״ח שמירה ${statusWord(r.overall)} — ${r.purchases.ordersWindow} הזמנות, ${r.shipments.pendingCount} משלוחים`,
    text: renderReportText(r),
    html: renderReportHtml(r),
  };
}

module.exports = { buildReport, runSelfChecks, renderReportEmail, renderReportText, renderReportHtml };
