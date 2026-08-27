/* ============================================================
   sole&luna — production Node server
   SQLite + REST API + Grow (Meshulam) payments
   Run: npm install && npm start
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");
const bcrypt = require("bcryptjs");
const {
  openDb, getAllProducts, getProduct, getStock, decrementStock, newOrderNum,
  logEvent, getMeta, setMeta,
} = require("./db");
const { notifyOrderPaid, sendEmail } = require("./mail");
const { buildReport, renderReportEmail } = require("./monitor");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const MAX_BODY = 32 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const PAYMENT_TTL_MS = 30 * 60_000;
const COOKIE_NAME = "sl_session";
const BCRYPT_ROUNDS = 10;

const ADMIN_PASS = process.env.ADMIN_PASS || "";
const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.GROW_ENV === "production";
const PAYMENTS_CONFIGURED = !!(process.env.GROW_USER_ID && process.env.GROW_PAGE_CODE && process.env.GROW_API_KEY);
const ALLOW_DEMO_CHECKOUT = process.env.ALLOW_DEMO_CHECKOUT === "true" ||
  (!PAYMENTS_CONFIGURED && !IS_PRODUCTION);

/* ---- Watchtower monitoring ---- */
const STARTED_AT = Date.now();
const REPORT_INTERVAL_HOURS = Math.max(1, Number(process.env.REPORT_INTERVAL_HOURS) || 12);
const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD);
const MONITOR_EMAIL = process.env.NOTIFY_EMAIL || process.env.ORDER_EMAIL || "solelunabsns@gmail.com";
const CRON_KEY = process.env.CRON_KEY || "";

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2",
  ".mp4": "video/mp4", ".webm": "video/webm", ".xml": "application/xml; charset=utf-8",
};

const { db, catalog: CATALOG } = openDb();

const GROW = {
  userId: process.env.GROW_USER_ID || "",
  pageCode: process.env.GROW_PAGE_CODE || "",
  apiKey: process.env.GROW_API_KEY || "",
  base: (process.env.GROW_ENV === "production")
    ? "https://secure.meshulam.co.il/api/light/server/1.0"
    : "https://sandbox.meshulam.co.il/api/light/server/1.0",
};

const rateBuckets = new Map();
const loginBuckets = new Map();
const pendingPayments = new Map();
const verifyTokens = new Map();

function monitorCtx() {
  return {
    startedAt: STARTED_AT,
    dataDir: require("./db").DATA_DIR,
    windowHours: REPORT_INTERVAL_HOURS,
    lowStockThreshold: Number.isFinite(LOW_STOCK_THRESHOLD) ? LOW_STOCK_THRESHOLD : 3,
    paymentsConfigured: PAYMENTS_CONFIGURED,
    isProduction: IS_PRODUCTION,
    allowDemoCheckout: ALLOW_DEMO_CHECKOUT,
  };
}

// Build the report and email it to the owner. Guarded so it never sends more
// than once per (interval - 5min), whichever trigger fires first (timer or cron).
async function sendReport(reason) {
  const last = Number(getMeta(db, "last_report_at") || 0);
  const minGap = (REPORT_INTERVAL_HOURS * 3600_000) - 5 * 60_000;
  if (Date.now() - last < minGap) {
    return { sent: false, skipped: "too_soon", nextInMs: minGap - (Date.now() - last) };
  }
  const report = buildReport(db, monitorCtx());
  setMeta(db, "last_report_at", Date.now());
  logEvent(db, "report", `sent (${reason}) — ${report.overall}`);
  if (!MONITOR_EMAIL) {
    return { sent: false, skipped: "no_recipient", overall: report.overall };
  }
  const { subject, text, html } = renderReportEmail(report);
  const r = await sendEmail({ to: MONITOR_EMAIL, subject, text, html });
  return { sent: !!r.ok, mail: r, overall: report.overall };
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function rateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count <= RATE_MAX;
}

// Tighter, separate budget for password-guessing endpoints (admin + user
// login) — the general API limit alone (60/min) is loose enough to brute
// force a weak password; this caps it independently of normal browsing traffic.
const LOGIN_RATE_WINDOW_MS = 15 * 60_000;
const LOGIN_RATE_MAX = 10;
function loginRateLimit(ip) {
  const now = Date.now();
  let bucket = loginBuckets.get(ip);
  if (!bucket || now - bucket.start > LOGIN_RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    loginBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count <= LOGIN_RATE_MAX;
}

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

function pruneMaps() {
  const now = Date.now();
  for (const [k, v] of pendingPayments) {
    if (now - v.createdAt > PAYMENT_TTL_MS) pendingPayments.delete(k);
  }
  for (const [k, v] of verifyTokens) {
    if (now - v.createdAt > PAYMENT_TTL_MS) verifyTokens.delete(k);
  }
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure || IS_PRODUCTION) parts.push("Secure");
  const existing = res.getHeader("Set-Cookie");
  if (existing) {
    const arr = Array.isArray(existing) ? existing : [existing];
    res.setHeader("Set-Cookie", [...arr, parts.join("; ")]);
  } else {
    res.setHeader("Set-Cookie", parts.join("; "));
  }
}

function clearCookie(res, name) {
  setCookie(res, name, "", { maxAge: 0 });
}

function getSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!row || row.expires_at < Date.now()) {
    if (row) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  let user = null;
  if (row.user_id) {
    user = db.prepare("SELECT id, email, name, phone, created_at FROM users WHERE id = ? AND deleted_at IS NULL").get(row.user_id);
  }
  return { token, isAdmin: !!row.is_admin, user };
}

function createSession(res, { userId = null, isAdmin = false } = {}) {
  const token = newToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare("INSERT INTO sessions (token, user_id, is_admin, expires_at) VALUES (?, ?, ?, ?)")
    .run(token, userId, isAdmin ? 1 : 0, expiresAt);
  setCookie(res, COOKIE_NAME, token, { maxAge: Math.floor(SESSION_TTL_MS / 1000) });
  return token;
}

function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  clearCookie(res, COOKIE_NAME);
}

function requireAdmin(session) {
  return session && session.isAdmin;
}

function validateCart(cart, coupon) {
  if (!Array.isArray(cart) || !cart.length) return { error: "הסל ריק" };
  if (cart.length > CATALOG.maxCartLines) return { error: "יותר מדי פריטים בסל" };

  let sub = 0;
  const lines = [];
  for (const line of cart) {
    const id = String(line.id || "");
    const product = getProduct(db, id);
    if (!product) return { error: "פריט לא תקין בסל" };
    const qty = Math.min(CATALOG.maxQtyPerLine, Math.max(1, Math.floor(Number(line.qty) || 1)));
    const size = String(line.size || product.sizes[0] || "");
    const color = String(line.color || (product.inventory.colors[0] && product.inventory.colors[0].name) || "");
    if (!product.sizes.includes(size)) return { error: `מידה לא תקינה: ${product.name}` };
    const stock = getStock(db, id, color, size);
    if (stock < qty) return { error: `אין מספיק מלאי: ${product.name} (${color} / ${size})` };
    const price = product.price;
    sub += price * qty;
    lines.push({ product_id: id, size, color, qty, price, name: product.name });
  }

  let discount = 0;
  const code = coupon ? String(coupon).trim().toUpperCase() : "";
  if (code) {
    const pct = CATALOG.coupons[code];
    if (pct == null) return { error: "קוד קופון לא תקין" };
    discount = Math.round(sub * pct);
  }

  const afterDiscount = sub - discount;
  const shipping = afterDiscount >= CATALOG.freeShipOver || sub === 0 ? 0 : CATALOG.shippingCost;
  const total = Math.round(afterDiscount + shipping);
  if (total < 1) return { error: "סכום תשלום לא תקין" };
  return { total, sub, discount, shipping, coupon: code || null, lines };
}

async function createGrowPayment(sum, description, origin, sessionToken) {
  if (!GROW.userId || !GROW.pageCode || !GROW.apiKey) return { configured: false };
  const body = new URLSearchParams({
    pageCode: GROW.pageCode,
    userId: GROW.userId,
    apiKey: GROW.apiKey,
    sum: String(sum),
    description: description || "sole&luna order",
    chargeType: "1",
    successUrl: origin + "/thank-you?session=" + encodeURIComponent(sessionToken),
    cancelUrl: origin + "/?canceled=1",
  });
  const r = await fetch(GROW.base + "/createPaymentProcess", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await r.json();
  const url = json && json.data && json.data.url;
  return url ? { configured: true, url } : { configured: true, error: "payment_gateway_error" };
}

function createOrder(orderData) {
  const orderNum = newOrderNum();
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO orders (order_num, user_id, status, total, subtotal, discount, shipping, coupon, email, gift_name, gift_msg, payment_token, created_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderNum, orderData.userId || null, orderData.total, orderData.sub,
    orderData.discount, orderData.shipping, orderData.coupon,
    orderData.email || null, orderData.giftName || null, orderData.giftMsg || null,
    orderData.paymentToken, now,
  );
  const orderId = info.lastInsertRowid;
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, size, color, qty, price)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const line of orderData.lines) {
      insertItem.run(orderId, line.product_id, line.size, line.color, line.qty, line.price);
    }
  });
  tx();
  return { orderId, orderNum };
}

function fulfillOrder(orderId) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order || order.status === "paid") return null;
  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(orderId);
  const tx = db.transaction(() => {
    for (const item of items) {
      const ok = decrementStock(db, item.product_id, item.color, item.size, item.qty);
      if (!ok) throw new Error("stock");
    }
    db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?").run(Date.now(), orderId);
  });
  try {
    tx();
  } catch {
    return null;
  }
  const paid = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  notifyOrderPaid(paid, items).catch((e) => console.error("[order] notify failed:", e.message));
  return paid;
}

function replaceProductInventory(productId, colors, stock) {
  const p = getProduct(db, productId);
  if (!p) return false;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM inventory WHERE product_id = ?").run(productId);
    const ins = db.prepare(`
      INSERT INTO inventory (product_id, color_name, color_hex, size, stock)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const c of colors) {
      const sizes = stock[c.name] || {};
      for (const size of p.sizes) {
        ins.run(productId, c.name, c.hex || "#888888", size, Math.max(0, Math.floor(Number(sizes[size]) || 0)));
      }
    }
  });
  tx();
  return true;
}

function secure(res) {
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(self)");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(new Error("body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function parseJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

function serveStatic(req, u, res) {
  let pathname = decodeURIComponent(u.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(ROOT, path.normalize(pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const cache = ext === ".html"
      ? "no-cache"
      : (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" ||
         ext === ".mp4" || ext === ".webm" || ext === ".woff" || ext === ".woff2")
        // cached hard, but NOT immutable: browsers revalidate with the ETag, so a
        // replaced photo reaches visitors immediately instead of a week later
        ? "public, max-age=86400, must-revalidate"
        : "public, max-age=300";
    // content version from size+mtime — changes the moment a file is replaced
    const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag, "Cache-Control": cache }); res.end(); return; }
    const headers = { "Content-Type": type, "Cache-Control": cache, ETag: etag, "Accept-Ranges": "bytes" };

    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : stat.size - parseInt(m[2], 10);
      let end = m[1] && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://" + req.headers.host);
  secure(res);
  pruneMaps();

  const ip = clientIp(req);
  const isApi = u.pathname.startsWith("/api/");

  // Force HTTPS for browser navigation only. Never redirect API calls or the
  // platform health check (/api/config) — those must answer 2xx directly, or
  // the host marks the deploy unhealthy.
  if (!isApi && req.headers["x-forwarded-proto"] === "http" && IS_PRODUCTION) {
    res.writeHead(301, { Location: "https://" + req.headers.host + req.url });
    res.end();
    return;
  }

  if (isApi && !rateLimit(ip)) {
    json(res, 429, { error: "יותר מדי בקשות — נסו שוב בעוד דקה" });
    return;
  }

  const session = getSession(req);

  try {
    /* ---- GET /api/config ---- */
    if (req.method === "GET" && u.pathname === "/api/config") {
      json(res, 200, {
        demoCheckout: ALLOW_DEMO_CHECKOUT,
        paymentsConfigured: PAYMENTS_CONFIGURED,
        adminEnabled: !!ADMIN_PASS,
      });
      return;
    }

    /* ---- GET /api/products ---- */
    if (req.method === "GET" && u.pathname === "/api/products") {
      json(res, 200, {
        products: getAllProducts(db),
        coupons: CATALOG.coupons,
        freeShipOver: CATALOG.freeShipOver,
        shippingCost: CATALOG.shippingCost,
      });
      return;
    }

    /* ---- Auth ---- */
    if (req.method === "POST" && u.pathname === "/api/auth/register") {
      const body = await parseJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const name = String(body.name || "").trim() || email.split("@")[0];
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        json(res, 400, { error: "אימייל לא תקין" }); return;
      }
      if (password.length < 6) { json(res, 400, { error: "סיסמה חייבת להכיל לפחות 6 תווים" }); return; }
      const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (existing) { json(res, 409, { error: "כתובת האימייל כבר רשומה" }); return; }
      const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
      const info = db.prepare("INSERT INTO users (email, password_hash, name, created_at) VALUES (?, ?, ?, ?)")
        .run(email, hash, name, Date.now());
      destroySession(req, res);
      createSession(res, { userId: info.lastInsertRowid });
      json(res, 201, { ok: true, user: { id: info.lastInsertRowid, email, name } });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/auth/login") {
      if (!loginRateLimit(ip)) { json(res, 429, { error: "יותר מדי ניסיונות התחברות — נסו שוב בעוד כמה דקות" }); return; }
      const body = await parseJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const user = db.prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL").get(email);
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        json(res, 401, { error: "אימייל או סיסמה שגויים" }); return;
      }
      destroySession(req, res);
      createSession(res, { userId: user.id });
      json(res, 200, { ok: true, user: { id: user.id, email: user.email, name: user.name, phone: user.phone } });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/auth/logout") {
      destroySession(req, res);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && u.pathname === "/api/auth/me") {
      if (!session || !session.user) { json(res, 401, { ok: false }); return; }
      const orders = db.prepare(`
        SELECT order_num, total, status, created_at, paid_at
        FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
      `).all(session.user.id);
      json(res, 200, { ok: true, user: session.user, orders });
      return;
    }

    if (req.method === "PATCH" && u.pathname === "/api/auth/me") {
      if (!session || !session.user) { json(res, 401, { error: "לא מחובר" }); return; }
      const body = await parseJson(req);
      const name = String(body.name != null ? body.name : session.user.name || "").trim().slice(0, 120);
      const phone = String(body.phone != null ? body.phone : session.user.phone || "").trim().slice(0, 32);
      db.prepare("UPDATE users SET name = ?, phone = ? WHERE id = ?").run(name, phone, session.user.id);
      json(res, 200, { ok: true, user: { ...session.user, name, phone } });
      return;
    }

    if ((req.method === "DELETE" || req.method === "POST") && u.pathname === "/api/auth/delete") {
      if (!session || !session.user) { json(res, 401, { error: "לא מחובר" }); return; }
      const uid = session.user.id;
      // Soft-delete: mark deleted, release the unique email, and neutralize the
      // login. Orders keep their history (user_id → SET NULL via FK) for reports.
      const scrambled = `deleted+${uid}.${Date.now()}@soleluna.invalid`;
      db.prepare("UPDATE users SET deleted_at = ?, email = ?, password_hash = '', name = NULL, phone = NULL WHERE id = ?")
        .run(Date.now(), scrambled, uid);
      logEvent(db, "account_deleted", `user #${uid}`);
      destroySession(req, res);
      json(res, 200, { ok: true });
      return;
    }

    /* ---- Newsletter & Contact ---- */
    if (req.method === "POST" && u.pathname === "/api/newsletter") {
      const body = await parseJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        json(res, 400, { error: "אימייל לא תקין" }); return;
      }
      try {
        db.prepare("INSERT INTO newsletter_subscribers (email, created_at) VALUES (?, ?)").run(email, Date.now());
      } catch (e) {
        if (String(e.message).includes("UNIQUE")) {
          json(res, 200, { ok: true, message: "כבר רשומים לרשימה" }); return;
        }
        throw e;
      }
      json(res, 201, { ok: true });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/contact") {
      const body = await parseJson(req);
      const email = String(body.email || "").trim();
      const message = String(body.message || "").trim();
      const name = String(body.name || "").trim();
      if (!email || !message) { json(res, 400, { error: "נא למלא אימייל והודעה" }); return; }
      db.prepare("INSERT INTO contact_messages (name, email, message, created_at) VALUES (?, ?, ?, ?)")
        .run(name, email, message, Date.now());
      const { sendEmail } = require("./mail");
      const notifyTo = process.env.NOTIFY_EMAIL;
      if (notifyTo) {
        sendEmail({
          to: notifyTo,
          subject: "פנייה חדשה מ-" + (name || email),
          text: `שם: ${name || "—"}\nאימייל: ${email}\n\n${message}`,
        }).catch(() => {});
      }
      json(res, 201, { ok: true });
      return;
    }

    /* ---- Admin ---- */
    if (req.method === "POST" && u.pathname === "/api/admin/login") {
      if (!ADMIN_PASS) { json(res, 403, { ok: false }); return; }
      if (!loginRateLimit(ip)) { json(res, 429, { ok: false, error: "יותר מדי ניסיונות — נסו שוב בעוד כמה דקות" }); return; }
      const body = await parseJson(req);
      const password = String(body.password || "");
      const a = Buffer.from(password);
      const b = Buffer.from(ADMIN_PASS);
      const ok = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
      if (!ok) { json(res, 401, { ok: false }); return; }
      destroySession(req, res);
      createSession(res, { isAdmin: true });
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/admin/logout") {
      if (session && session.isAdmin) destroySession(req, res);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/admin/orders") {
      if (!requireAdmin(session)) { json(res, 403, { error: "אין הרשאה" }); return; }
      const orders = db.prepare(`
        SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
        FROM orders o ORDER BY o.created_at DESC LIMIT 200
      `).all();
      const withItems = orders.map((o) => ({
        ...o,
        items: db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(o.id),
      }));
      const stats = {
        orders: orders.length,
        paid: orders.filter((o) => o.status === "paid").length,
        revenue: orders.filter((o) => o.status === "paid").reduce((s, o) => s + o.total, 0),
        subscribers: db.prepare("SELECT COUNT(*) AS n FROM newsletter_subscribers").get().n,
        users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
      };
      json(res, 200, { orders: withItems, stats });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/admin/customers") {
      if (!requireAdmin(session)) { json(res, 403, { error: "אין הרשאה" }); return; }
      const customers = db.prepare(`
        SELECT u.id, u.email, u.name, u.phone, u.created_at,
          (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orderCount,
          (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS totalSpent
        FROM users u WHERE u.deleted_at IS NULL
        ORDER BY totalSpent DESC, u.created_at DESC
        LIMIT 500
      `).all();
      json(res, 200, { customers });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/admin/contact-messages") {
      if (!requireAdmin(session)) { json(res, 403, { error: "אין הרשאה" }); return; }
      const messages = db.prepare(`
        SELECT id, name, email, message, created_at FROM contact_messages
        ORDER BY created_at DESC LIMIT 300
      `).all();
      json(res, 200, { messages });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/admin/sales-breakdown") {
      if (!requireAdmin(session)) { json(res, 403, { error: "אין הרשאה" }); return; }
      const byColor = db.prepare(`
        SELECT oi.color, SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS revenue
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.status = 'paid'
        GROUP BY oi.color ORDER BY qty DESC
      `).all();
      const byProduct = db.prepare(`
        SELECT oi.product_id, oi.color, oi.size, SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS revenue
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.status = 'paid'
        GROUP BY oi.product_id, oi.color, oi.size ORDER BY qty DESC
        LIMIT 500
      `).all();
      const nameById = new Map(getAllProducts(db).map((p) => [p.id, p.name]));
      for (const row of byProduct) row.name = nameById.get(row.product_id) || row.product_id;
      json(res, 200, { byColor, byProduct });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/admin/inventory") {
      if (!requireAdmin(session)) { json(res, 403, { error: "אין הרשאה" }); return; }
      json(res, 200, { products: getAllProducts(db) });
      return;
    }

    /* ---- Watchtower: live monitoring report (admin) ---- */
    if ((req.method === "GET" || req.method === "POST") && u.pathname === "/api/admin/monitor") {
      if (!requireAdmin(session)) { json(res, 403, { error: "אין הרשאה" }); return; }
      json(res, 200, buildReport(db, monitorCtx()));
      return;
    }

    /* ---- Watchtower: mark an order as shipped (admin) ---- */
    if (req.method === "POST" && u.pathname === "/api/admin/orders/ship") {
      if (!requireAdmin(session)) { json(res, 403, { error: "אין הרשאה" }); return; }
      const body = await parseJson(req);
      const orderNum = String(body.orderNum || "").trim();
      const shipped = body.shipped === false ? null : Date.now();
      const info = db.prepare("UPDATE orders SET shipped_at = ? WHERE order_num = ? AND status = 'paid'")
        .run(shipped, orderNum);
      if (!info.changes) { json(res, 404, { error: "הזמנה לא נמצאה או לא שולמה" }); return; }
      logEvent(db, "shipment", `${orderNum} ${shipped ? "shipped" : "unmarked"}`);
      json(res, 200, { ok: true, orderNum, shipped: !!shipped });
      return;
    }

    /* ---- Watchtower: cron-triggered 12h report (external scheduler) ---- */
    if ((req.method === "GET" || req.method === "POST") && u.pathname === "/api/cron/report") {
      const key = u.searchParams.get("key") || (await parseJson(req).catch(() => ({}))).key || "";
      if (!CRON_KEY || key !== CRON_KEY) { json(res, 403, { error: "forbidden" }); return; }
      const force = u.searchParams.get("force") === "1";
      if (force) setMeta(db, "last_report_at", "0");
      const out = await sendReport("cron");
      json(res, 200, { ok: true, ...out });
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/admin/inventory/update") {
      if (!requireAdmin(session)) { json(res, 403, { error: "אין הרשאה" }); return; }
      const body = await parseJson(req);
      const productId = String(body.productId || "");
      if (!getProduct(db, productId)) { json(res, 404, { error: "מוצר לא נמצא" }); return; }

      if (body.price != null) {
        const price = Math.max(0, Math.floor(Number(body.price)));
        db.prepare("UPDATE products SET price = ? WHERE id = ?").run(price, productId);
      }

      if (Array.isArray(body.colors) && body.stock && typeof body.stock === "object") {
        replaceProductInventory(productId, body.colors, body.stock);
      } else if (body.stock && typeof body.stock === "object") {
        const upd = db.prepare(`
          UPDATE inventory SET stock = ? WHERE product_id = ? AND color_name = ? AND size = ?
        `);
        for (const [color, sizes] of Object.entries(body.stock)) {
          for (const [size, qty] of Object.entries(sizes)) {
            upd.run(Math.max(0, Math.floor(Number(qty) || 0)), productId, color, size);
          }
        }
      }

      json(res, 200, { ok: true, product: getProduct(db, productId) });
      return;
    }

    /* ---- Bulk: mark every product sold out and clear all discounts (pre-launch mode) ---- */
    if (req.method === "POST" && u.pathname === "/api/admin/inventory/clear-for-launch") {
      if (!requireAdmin(session)) { json(res, 403, { error: "אין הרשאה" }); return; }
      const soldOut = db.prepare("UPDATE inventory SET stock = 0").run();
      const cleared = db.prepare("UPDATE products SET compare_at_price = NULL").run();
      logEvent(db, "bulk_clear_for_launch", `stock rows=${soldOut.changes} discounts cleared=${cleared.changes}`);
      json(res, 200, { ok: true, stockRowsUpdated: soldOut.changes, productsDiscountCleared: cleared.changes });
      return;
    }

    /* Legacy admin-verify (redirect clients to /api/admin/login) */
    if (req.method === "POST" && u.pathname === "/api/admin-verify") {
      if (!ADMIN_PASS) { json(res, 403, { ok: false }); return; }
      const body = await parseJson(req);
      const password = String(body.password || "");
      const a = Buffer.from(password);
      const b = Buffer.from(ADMIN_PASS);
      const ok = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
      if (ok) { destroySession(req, res); createSession(res, { isAdmin: true }); }
      json(res, ok ? 200 : 401, { ok });
      return;
    }

    /* ---- Payment verify ---- */
    if (req.method === "GET" && u.pathname === "/api/verify-payment") {
      const token = u.searchParams.get("token") || "";
      const record = verifyTokens.get(token);
      if (!record) { json(res, 404, { ok: false }); return; }
      verifyTokens.delete(token);
      const order = fulfillOrder(record.orderId);
      if (!order) { json(res, 409, { ok: false, error: "לא ניתן להשלים את ההזמנה" }); return; }
      json(res, 200, {
        ok: true,
        total: record.total,
        orderNum: order.order_num,
      });
      return;
    }

    /* ---- Create payment ---- */
    if (req.method === "POST" && u.pathname === "/api/create-payment") {
      const body = await parseJson(req);
      const orderCalc = validateCart(body.cart, body.coupon);
      if (orderCalc.error) { json(res, 400, { error: orderCalc.error }); return; }

      const guestEmail = String(body.email || "").trim();
      if (guestEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
        json(res, 400, { error: "אימייל לא תקין" }); return;
      }
      const email = guestEmail || (session && session.user && session.user.email) || "";
      const giftName = String(body.giftName || "").trim().slice(0, 120) || null;
      const giftMsg = String(body.giftMsg || "").trim().slice(0, 500) || null;

      const paymentSession = newToken();
      const { orderId, orderNum } = createOrder({
        userId: session && session.user ? session.user.id : null,
        total: orderCalc.total,
        sub: orderCalc.sub,
        discount: orderCalc.discount,
        shipping: orderCalc.shipping,
        coupon: orderCalc.coupon,
        email,
        giftName,
        giftMsg,
        paymentToken: paymentSession,
        lines: orderCalc.lines,
      });

      const proto = req.headers["x-forwarded-proto"] || "http";
      const origin = proto + "://" + req.headers.host;
      pendingPayments.set(paymentSession, { orderId, orderNum, total: orderCalc.total, createdAt: Date.now() });

      const out = await createGrowPayment(orderCalc.total, body.description || "sole&luna order", origin, paymentSession);
      if (!out.configured) {
        pendingPayments.delete(paymentSession);
        db.prepare("UPDATE orders SET status = 'canceled' WHERE id = ?").run(orderId);
        if (ALLOW_DEMO_CHECKOUT && !IS_PRODUCTION) {
          const demoToken = newToken();
          verifyTokens.set(demoToken, { orderId, total: orderCalc.total, createdAt: Date.now() });
          json(res, 200, { configured: false, demoAllowed: true, total: orderCalc.total, verifyToken: demoToken, orderNum });
        } else {
          json(res, 503, { error: "מערכת התשלומים אינה מוגדרת" });
        }
        return;
      }
      if (!out.url) {
        pendingPayments.delete(paymentSession);
        db.prepare("UPDATE orders SET status = 'canceled' WHERE id = ?").run(orderId);
        json(res, 502, { error: "שגיאה ביצירת תשלום — נסו שוב" });
        return;
      }
      json(res, 200, { configured: true, url: out.url, total: orderCalc.total, orderNum });
      return;
    }

    /* ---- thank-you redirect ---- */
    if (u.pathname === "/thank-you") {
      const paySession = u.searchParams.get("session") || "";
      const pending = pendingPayments.get(paySession);
      if (!pending) {
        res.writeHead(302, { Location: "/?payment_error=1" });
        res.end();
        return;
      }
      pendingPayments.delete(paySession);
      const verifyToken = newToken();
      verifyTokens.set(verifyToken, { orderId: pending.orderId, total: pending.total, createdAt: Date.now() });
      res.writeHead(302, { Location: "/?payment=" + encodeURIComponent(verifyToken) });
      res.end();
      return;
    }

    /* ---- clean URL for the live monitoring dashboard ---- */
    if (u.pathname === "/monitor" || u.pathname === "/monitor/") {
      serveStatic(req, new URL("/monitor.html", "http://" + req.headers.host), res);
      return;
    }

    serveStatic(req, u, res);
  } catch (e) {
    const code = e.message === "body_too_large" ? 413 : (e instanceof SyntaxError ? 400 : 500);
    if (code === 500) {
      console.error("[server]", req.method, u.pathname, "→", e.stack || e.message);
      logEvent(db, "error", `${req.method} ${u.pathname} — ${e.message}`);
    }
    json(res, code, { error: code === 500 ? "שגיאת שרת" : "בקשה לא תקינה" });
  }
});

// Never let an unexpected throw take the whole site down silently — record it
// so it surfaces in the next Watchtower report, then keep serving.
process.on("uncaughtException", (e) => {
  console.error("[uncaught]", e.stack || e.message);
  try { logEvent(db, "error", "uncaughtException — " + e.message); } catch {}
});
process.on("unhandledRejection", (e) => {
  const msg = e && e.message ? e.message : String(e);
  console.error("[unhandledRejection]", msg);
  try { logEvent(db, "error", "unhandledRejection — " + msg); } catch {}
});

// In-process scheduler: while the instance is awake, fire the report once the
// interval has elapsed. The /api/cron/report endpoint is the reliable path on
// hosts that sleep idle instances — both are guarded against double-send.
const SCHED_TICK_MS = 15 * 60_000;
setInterval(() => {
  sendReport("timer").then((out) => {
    if (out.sent) console.log("[watchtower] 12h report sent —", out.overall);
  }).catch((e) => console.error("[watchtower] report failed:", e.message));
}, SCHED_TICK_MS).unref();

server.listen(PORT, () => {
  console.log("sole&luna running on http://localhost:" + PORT);
  console.log(`[watchtower] active · report every ${REPORT_INTERVAL_HOURS}h · recipient: ${MONITOR_EMAIL || "(not set)"} · cron: ${CRON_KEY ? "enabled" : "disabled"}`);
  if (IS_PRODUCTION && ALLOW_DEMO_CHECKOUT) {
    console.warn("WARNING: ALLOW_DEMO_CHECKOUT is enabled in production — disable before launch.");
  }
});
