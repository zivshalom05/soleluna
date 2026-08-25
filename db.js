/* sole&luna — SQLite database init, seed, helpers */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "soleluna.db");
const CATALOG_PATH = path.join(__dirname, "catalog.json");

// 5 real colorways — must match the client COLOR_SUFFIX map and the
// per-color photography files: img/products/{id}-{white|beige|brown|navy|sage}.png
// hexes calibrated to the actual garments in the photos
const DEFAULT_COLORS = [
  { name: "לבן", hex: "#EDE8DC" },   // white linen
  { name: "בז'", hex: "#D8C5A4" },   // warm sand
  { name: "חום", hex: "#9C6B4A" },   // terracotta brown
  { name: "נייבי", hex: "#23304E" },  // navy
  { name: "זית", hex: "#8C9A82" },   // sage / olive
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
}

function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      gender TEXT NOT NULL,
      type TEXT NOT NULL,
      fit TEXT NOT NULL,
      price INTEGER NOT NULL,
      compare_at_price INTEGER,
      cut TEXT,
      sizes TEXT NOT NULL,
      grad TEXT,
      img TEXT,
      tag TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory (
      product_id TEXT NOT NULL,
      color_name TEXT NOT NULL,
      color_hex TEXT NOT NULL,
      size TEXT NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (product_id, color_name, size),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER,
      is_admin INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_num TEXT NOT NULL UNIQUE,
      user_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      total INTEGER NOT NULL,
      subtotal INTEGER NOT NULL,
      discount INTEGER NOT NULL DEFAULT 0,
      shipping INTEGER NOT NULL DEFAULT 0,
      coupon TEXT,
      email TEXT,
      gift_name TEXT,
      gift_msg TEXT,
      payment_token TEXT,
      created_at INTEGER NOT NULL,
      paid_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      size TEXT NOT NULL,
      color TEXT NOT NULL,
      qty INTEGER NOT NULL,
      price INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Watchtower: health/security/audit events (errors, account deletions, report sends)
    CREATE TABLE IF NOT EXISTS system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );

    -- key/value store for scheduler bookkeeping (e.g. last report timestamp)
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_events_type_time ON system_events(type, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at);
  `);
}

// Idempotent column additions for databases created before Watchtower.
// SQLite has no "ADD COLUMN IF NOT EXISTS", so we check table_info first.
function migrateSchema(db) {
  const hasColumn = (table, col) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!hasColumn("orders", "shipped_at")) {
    db.exec("ALTER TABLE orders ADD COLUMN shipped_at INTEGER");
  }
  if (!hasColumn("users", "deleted_at")) {
    db.exec("ALTER TABLE users ADD COLUMN deleted_at INTEGER");
  }
  if (!hasColumn("products", "compare_at_price")) {
    db.exec("ALTER TABLE products ADD COLUMN compare_at_price INTEGER");
  }
  if (!hasColumn("products", "cut")) {
    db.exec("ALTER TABLE products ADD COLUMN cut TEXT");
  }
}

function logEvent(db, type, detail) {
  try {
    db.prepare("INSERT INTO system_events (type, detail, created_at) VALUES (?, ?, ?)")
      .run(String(type), detail == null ? null : String(detail).slice(0, 500), Date.now());
  } catch (e) {
    // Never let telemetry break a request.
    console.error("[events] log failed:", e.message);
  }
}

function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value == null ? null : String(value));
}

function seedProducts(db, catalog) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
  if (count > 0) return;

  const items = catalog.items || [];
  const insertProduct = db.prepare(`
    INSERT INTO products (id, name, gender, type, fit, price, compare_at_price, cut, sizes, grad, img, tag)
    VALUES (@id, @name, @gender, @type, @fit, @price, @compareAtPrice, @cut, @sizes, @grad, @img, @tag)
  `);
  const insertInv = db.prepare(`
    INSERT INTO inventory (product_id, color_name, color_hex, size, stock)
    VALUES (@product_id, @color_name, @color_hex, @size, @stock)
  `);

  const tx = db.transaction(() => {
    for (const p of items) {
      const price = catalog.products[p.id] != null ? catalog.products[p.id] : p.price;
      insertProduct.run({
        id: p.id,
        name: p.name,
        gender: p.gender,
        type: p.type,
        fit: p.fit,
        price,
        compareAtPrice: p.compareAt != null ? p.compareAt : null,
        cut: p.cut || null,
        sizes: JSON.stringify(p.sizes),
        grad: p.grad || null,
        img: p.img || null,
        tag: p.tag || null,
      });
      const colors = DEFAULT_COLORS;
      for (const c of colors) {
        for (const size of p.sizes) {
          insertInv.run({
            product_id: p.id,
            color_name: c.name,
            color_hex: c.hex,
            size,
            stock: 8,
          });
        }
      }
    }
  });
  tx();
  console.log("Database seeded with", items.length, "products");
}

function openDb() {
  ensureDataDir();
  const db = new Database(DB_PATH);
  initSchema(db);
  migrateSchema(db);
  const catalog = loadCatalog();
  seedProducts(db, catalog);
  return { db, catalog };
}

function rowToProduct(row, inventoryRows) {
  const sizes = JSON.parse(row.sizes);
  const colorsMap = new Map();
  const stock = {};
  for (const inv of inventoryRows) {
    if (!colorsMap.has(inv.color_name)) {
      colorsMap.set(inv.color_name, { name: inv.color_name, hex: inv.color_hex });
    }
    if (!stock[inv.color_name]) stock[inv.color_name] = {};
    stock[inv.color_name][inv.size] = inv.stock;
  }
  return {
    id: row.id,
    name: row.name,
    gender: row.gender,
    type: row.type,
    fit: row.fit,
    price: row.price,
    compareAtPrice: row.compare_at_price || null,
    cut: row.cut || null,
    sizes,
    grad: row.grad,
    img: row.img,
    tag: row.tag,
    inventory: {
      colors: Array.from(colorsMap.values()),
      stock,
    },
  };
}

function getAllProducts(db) {
  const products = db.prepare("SELECT * FROM products ORDER BY id").all();
  const inv = db.prepare("SELECT * FROM inventory ORDER BY product_id, color_name, size").all();
  const byProduct = new Map();
  for (const row of inv) {
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id).push(row);
  }
  return products.map((p) => rowToProduct(p, byProduct.get(p.id) || []));
}

function getProduct(db, id) {
  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  if (!row) return null;
  const inv = db.prepare("SELECT * FROM inventory WHERE product_id = ?").all(id);
  return rowToProduct(row, inv);
}

function getStock(db, productId, color, size) {
  const row = db.prepare(
    "SELECT stock FROM inventory WHERE product_id = ? AND color_name = ? AND size = ?"
  ).get(productId, color, size);
  return row ? row.stock : 0;
}

function decrementStock(db, productId, color, size, qty) {
  const result = db.prepare(`
    UPDATE inventory SET stock = stock - ?
    WHERE product_id = ? AND color_name = ? AND size = ? AND stock >= ?
  `).run(qty, productId, color, size, qty);
  return result.changes > 0;
}

function newOrderNum() {
  return "SL-" + String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = {
  openDb,
  loadCatalog,
  getAllProducts,
  getProduct,
  getStock,
  decrementStock,
  newOrderNum,
  logEvent,
  getMeta,
  setMeta,
  DB_PATH,
  DATA_DIR,
};
