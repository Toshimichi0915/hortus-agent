// Telegram Bot API: the token is a path segment, `/bot<token>/<method>` and `/file/bot<token>/<path>`.
export function request(req) {
  const url = req.url.replace(
    /^(https?:\/\/[^/?#]+(?:\/file)?)\/bothortus-secret-([a-z0-9_-]+)\//,
    "$1/bot{secret:$2}/",
  );
  return { ...req, url };
}

// sendMessage, sendDocument and the rest (each answers a Message) → refs `telegram:<chat>:<thread>`: the forum topic,
// else the replied-to message, else the message; and the sent message itself. The bot's messages are never updates and
// a reply carries no chain, so someone answering this message is on thread <this message> to the connector.
export function response(res, req) {
  const out = { res };
  if (!/\/send\w+(\?|$)/i.test(req.url) || !res.body) return out;
  let b;
  try {
    b = JSON.parse(res.body);
  } catch {
    return out;
  }
  const m = b?.ok && b.result;
  if (!m?.chat) return out;
  const r = m.reply_to_message;
  const thread = m.message_thread_id ?? r?.message_thread_id ?? r?.message_id ?? m.message_id;
  out.refs = [...new Set([thread, m.message_id])].map((t) => `telegram:${m.chat.id}:${t}`);
  return out;
}
