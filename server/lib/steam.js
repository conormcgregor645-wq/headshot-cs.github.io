"use strict";
// Вход через Steam (OpenID 2.0) и данные профиля через Steam Web API.
const OPENID = "https://steamcommunity.com/openid/login";

function loginUrl(siteUrl, ret) {
  const returnTo = siteUrl + "/auth/steam/return" + (ret ? "?ret=" + encodeURIComponent(ret) : "");
  const p = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": siteUrl,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return OPENID + "?" + p.toString();
}

// проверка ответа Steam. Возвращает steamid64 или null.
async function verify(siteUrl, query, fetchImpl = fetch) {
  if (query.get("openid.mode") !== "id_res") return null;
  const ret = query.get("openid.return_to") || "";
  if (!ret.startsWith(siteUrl + "/auth/steam/return")) return null;
  if ((query.get("openid.op_endpoint") || "") !== OPENID) return null;
  const claimed = query.get("openid.claimed_id") || "";
  const m = claimed.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  if (!m) return null;
  const body = new URLSearchParams();
  for (const [k, v] of query) if (k.startsWith("openid.")) body.set(k, v);
  body.set("openid.mode", "check_authentication");
  const r = await fetchImpl(OPENID, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10000) });
  const t = await r.text();
  if (!/is_valid\s*:\s*true/.test(t)) return null;
  return m[1];
}

async function profile(apiKey, steamid, fetchImpl = fetch) {
  if (!apiKey) return null;
  try {
    const r = await fetchImpl(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${steamid}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json(); const p = j && j.response && j.response.players && j.response.players[0];
    if (!p) return null;
    // ник чистим от символов разметки, аватар принимаем только с серверов Steam
    const name = String(p.personaname || "").replace(/[<>&"'`\\\u0000-\u001f\u2028\u2029]/g, "").trim().slice(0, 32);
    const av = String(p.avatarfull || p.avatarmedium || "");
    return { name, avatar: /^https:\/\/[a-z0-9.-]+\.(steamstatic\.com|akamaihd\.net)\/[\w\-./]+$/i.test(av) ? av : "" };
  } catch (e) { return null; }
}

module.exports = { loginUrl, verify, profile };
