// Telegram Bot API: the token is a path segment, `/bot<token>/<method>` and `/file/bot<token>/<path>`.
export function request(req) {
  const url = req.url.replace(
    /^(https?:\/\/[^/?#]+(?:\/file)?)\/bothortus-secret-([a-z0-9_-]+)\//,
    "$1/bot{secret:$2}/",
  );
  return { ...req, url };
}

// sendMessage → refs `telegram:<chat>:<thread>`: the forum topic, else the replied-to message, else the message.
export function response(res, req) {
  const out = { res };
  if (!/\/sendMessage(\?|$)/.test(req.url) || !res.body) return out;
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
  out.refs = [`telegram:${m.chat.id}:${thread}`];
  return out;
}
