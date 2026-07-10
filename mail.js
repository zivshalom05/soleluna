/* sole&luna — optional order / contact notifications (no extra npm deps) */
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || process.env.ORDER_EMAIL || "solelunabsns@gmail.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "orders@soleluna.co.il";

async function sendEmail({ to, subject, text, html }) {
  if (!to) return { ok: false, skipped: true };
  if (RESEND_API_KEY) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + RESEND_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [to],
          subject,
          text,
          html: html || text.replace(/\n/g, "<br>"),
        }),
      });
      if (!r.ok) {
        const err = await r.text();
        console.error("[mail] Resend error:", err);
        return { ok: false, error: err };
      }
      return { ok: true };
    } catch (e) {
      console.error("[mail] Resend failed:", e.message);
      return { ok: false, error: e.message };
    }
  }
  console.log("[mail] (no RESEND_API_KEY) — would send to", to, ":", subject);
  console.log(text);
  return { ok: true, logged: true };
}

async function notifyOrderPaid(order, items) {
  const lines = (items || []).map((i) =>
    `• ${i.qty}× ${i.product_id} (${i.color} / ${i.size}) — ₪${i.price * i.qty}`
  ).join("\n");
  const text = [
    `הזמנה חדשה שולמה — ${order.order_num}`,
    `סכום: ₪${order.total}`,
    order.email ? `לקוח: ${order.email}` : "",
    order.gift_name ? `מתנה ל: ${order.gift_name}` : "",
    "",
    "פריטים:",
    lines,
  ].filter(Boolean).join("\n");

  const tasks = [];
  if (NOTIFY_EMAIL) {
    tasks.push(sendEmail({
      to: NOTIFY_EMAIL,
      subject: `sole&luna · הזמנה ${order.order_num} שולמה`,
      text,
    }));
  }
  if (order.email) {
    tasks.push(sendEmail({
      to: order.email,
      subject: `אישור הזמנה ${order.order_num} · sole&luna`,
      text: `תודה על הקנייה!\n\nמספר הזמנה: ${order.order_num}\nסכום: ₪${order.total}\n\nניצור איתכם קשר לגבי המשלוח.\n\nsole&luna`,
    }));
  }
  await Promise.all(tasks);
}

module.exports = { sendEmail, notifyOrderPaid };
