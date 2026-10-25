// lib/notify.js - sending phone alerts and remembering which ones were already sent. No dependencies: global fetch only.
//
// Channels (set the environment variables in Vercel; nothing is read from the request):
//   Telegram : TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   ntfy     : NTFY_TOPIC (use a long random topic name; anyone who knows it can read it) and optional NTFY_SERVER
// Duplicate protection (optional but recommended): an Upstash Redis REST database, UPSTASH_REDIS_REST_URL + _TOKEN.
// Without it the caller falls back to "only alert on events from the last few minutes".

const TIMEOUT_MS = 8000;

function channelsFrom(env) {
  const out = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) out.push("telegram");
  if (env.NTFY_TOPIC) out.push("ntfy");
  return out;
}

async function post(fetchImpl, url, init) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// One event to one channel. Errors carry only the channel name and status, never the URL or a token.
async function sendOne(channel, ev, env, fetchImpl = fetch) {
  try {
    if (channel === "telegram") {
      await post(fetchImpl, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${ev.title}\n\n${ev.text}`, disable_web_page_preview: true }),
      });
    } else if (channel === "ntfy") {
      const server = String(env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
      await post(fetchImpl, `${server}/${encodeURIComponent(env.NTFY_TOPIC)}`, {
        method: "POST",
        headers: { Title: String(ev.title).replace(/[^\x20-\x7e]/g, "-"), Priority: ev.priority === "high" ? "high" : "default", Tags: ev.kind },
        body: ev.text,
      });
    } else throw new Error("unknown channel");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `${channel}: ${e && e.name === "TimeoutError" ? "timeout" : String((e && e.message) || e).replace(/https?:\/\/\S+/g, "")}` };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Duplicate protection: an atomic "claim this event id once" on an Upstash Redis REST database.
function kvFrom(env, fetchImpl = fetch) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const cmd = async (args) => {
    const res = await post(fetchImpl, String(url).replace(/\/+$/, ""), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return (await res.json()).result;
  };
  return {
    // true when this id was not seen before (and is now remembered for two days)
    async claim(id) {
      return (await cmd(["SET", "nse:alert:" + id, "1", "NX", "EX", 172800])) === "OK";
    },
    // forget it again, used when sending failed so the next run can retry
    async release(id) {
      await cmd(["DEL", "nse:alert:" + id]);
    },
  };
}

module.exports = { channelsFrom, sendOne, kvFrom };
