/* AVASTHA contact form → Resend, via Cloudflare Worker.
   Receives JSON { name, email, subject, message } from avastha.info/contact,
   sends a branded HTML email to the band's inboxes, and sets reply-to so a
   reply goes straight back to the sender.

   Cloudflare setup: Worker name → contact-avastha (URL
   https://contact-avastha.adidatabase.workers.dev/), Settings → Variables and
   Secrets → RESEND_API_KEY (secret). Optional ALLOW_ORIGIN = https://avastha.info
*/
export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

    const json = (obj, status) => new Response(JSON.stringify(obj), {
      status: status || 200, headers: { "Content-Type": "application/json", ...cors },
    });

    try {
      const body = await request.json();
      const name    = String(body.name || "").trim().slice(0, 200);
      const email   = String(body.email || "").trim().slice(0, 200);
      const subject = String(body.subject || "General Inquiry").trim().slice(0, 120);
      const message = String(body.message || "").trim().slice(0, 8000);

      if (!name || !email || !message || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json({ error: "Missing or invalid fields" }, 400);
      }

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: "AVASTHA Website <contact@avastha.info>",
          to: ["avastha.music@gmail.com", "studio@avastha.info", "office@adiariel.com"],
          reply_to: email,
          subject: `[AVASTHA] 🔊 NEW | ${iso(subject)} | From: ${iso(name)}`,
          html: brandedEmail({ name, email, subject, message }),
        }),
      });

      if (res.ok) return json({ success: true }, 200);
      const details = await res.text();
      return json({ error: "Failed to send email", details }, 500);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};

/* ---------- helpers ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* Wrap a dynamic value in a Unicode directional isolate (First-Strong Isolate
   … Pop Directional Isolate). This stops a Hebrew name/subject from reordering
   the surrounding English/brackets/pipes in Gmail's inbox list (BiDi fix). */
const FSI = "\u2068", PDI = "\u2069";
function iso(s) { return FSI + String(s) + PDI; }

/* Branded, email-client-safe HTML (tables + inline CSS, hex colours only —
   no oklch/color-mix/backdrop-filter/web-fonts, which most clients strip).
   Auto-detects Hebrew from the submission and mirrors the whole layout to RTL
   with Hebrew labels; otherwise stays English LTR. */
function brandedEmail({ name, email, subject, message }) {
  const isHe = /[֐-׿]/.test(String(name || "") + " " + String(message || ""));
  const DIR = isHe ? "rtl" : "ltr", LANG = isHe ? "he" : "en";
  const L = isHe
    ? { from: "מאת", email: "מייל", message: "תוכן ההודעה", newmsg: "הודעה חדשה", reply: "השב לשולח", sent: "נשלח מטופס יצירת הקשר ב־" }
    : { from: "From", email: "Email", message: "Message", newmsg: "New Message", reply: "Reply to sender", sent: "Sent from the contact form at " };
  const SUBJ_HE = { "Booking Request": "הזמנת הופעה", "General Inquiry": "פנייה כללית", "Collaboration": "שיתוף פעולה" };
  const badge = esc(isHe ? (SUBJ_HE[subject] || subject) : subject);

  const N = esc(name), E = esc(email), S = esc(subject);
  const M = esc(message).replace(/\r?\n/g, "<br>");
  const BG = "#05060a", CARD = "#12141f", FIELD = "#0c0e17";
  const LINE = "#23263a", TEXT = "#f2f3fb", DIM = "#8b8fa6";
  const VIOLET = "#7c5cff", BLUE = "#3aa0ff";
  const GREEN = "#2fe6a4", GREEN_BG = "#0b1d16";

  return `<!DOCTYPE html>
<html lang="${LANG}" dir="${DIR}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>New message — AVASTHA</title>
</head>
<body dir="${DIR}" style="margin:0;padding:0;background-color:${BG};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BG};">New ${iso(S)} from ${iso(N)} — reply to reach them directly.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};padding:28px 14px;">
    <tr><td align="center">
      <table role="presentation" dir="${DIR}" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:${CARD};border:1px solid ${LINE};border-radius:16px;overflow:hidden;">

        <!-- header band -->
        <tr>
          <td style="background-color:${VIOLET};background-image:linear-gradient(120deg,${VIOLET},${BLUE});padding:22px 24px;">
            <table role="presentation" dir="${DIR}" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-family:Georgia,'Times New Roman',serif;font-size:20px;letter-spacing:4px;color:#ffffff;font-weight:bold;text-align:start;">A V A S T H A</td>
                <td style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;color:#ffffff;text-transform:uppercase;text-align:end;">${L.newmsg}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- subject banner — full-width rectangular green strip (pronounced, not a floating tag) -->
        <tr>
          <td style="padding:18px 0 4px 0;">
            <div dir="auto" style="background-color:${GREEN_BG};border-top:1px solid ${GREEN};border-bottom:1px solid ${GREEN};padding:16px 22px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:17px;letter-spacing:3px;text-transform:uppercase;color:${GREEN};font-weight:bold;">${badge}</div>
          </td>
        </tr>

        <!-- from -->
        <tr>
          <td style="padding:14px 32px 4px 32px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${DIM};padding-bottom:4px;text-align:start;">${L.from}</div>
            <div dir="auto" style="font-family:Arial,Helvetica,sans-serif;font-size:17px;color:${TEXT};font-weight:bold;text-align:start;">${N}</div>
          </td>
        </tr>

        <!-- email -->
        <tr>
          <td style="padding:12px 32px 4px 32px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${DIM};padding-bottom:4px;text-align:start;">${L.email}</div>
            <div style="text-align:start;"><a href="mailto:${E}" dir="ltr" style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:${BLUE};text-decoration:none;">${E}</a></div>
          </td>
        </tr>

        <!-- message -->
        <tr>
          <td style="padding:16px 32px 8px 32px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${DIM};padding-bottom:8px;text-align:start;">${L.message}</div>
            <div dir="auto" style="background-color:${FIELD};border:1px solid ${LINE};border-radius:12px;padding:18px 20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:${TEXT};text-align:start;">${M}</div>
          </td>
        </tr>

        <!-- reply button -->
        <tr>
          <td style="padding:22px 32px 30px 32px;" align="center">
            <a href="mailto:${E}?subject=${encodeURIComponent("RE: " + iso(subject) + " — AVASTHA")}" dir="${DIR}" style="display:inline-block;background-color:${VIOLET};background-image:linear-gradient(120deg,${VIOLET},${BLUE});color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;text-decoration:none;padding:14px 40px;border-radius:10px;">${L.reply}</a>
          </td>
        </tr>

        <!-- footer -->
        <tr>
          <td style="border-top:1px solid ${LINE};padding:20px 32px;background-color:${BG};" align="center">
            <div dir="${DIR}" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:${DIM};text-align:center;">
              ${L.sent}<a href="https://avastha.info" dir="ltr" style="color:${BLUE};text-decoration:none;">avastha.info</a>
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
