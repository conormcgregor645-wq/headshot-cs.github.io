"use strict";
// Чистка ников: «залго» (горы надстрочных знаков), невидимые и управляющие символы, смена направления текста.
// Обычные буквы любых языков, эмодзи, знаки и одна диакритика на букву (й, ё, é) остаются; на сайте ник всегда выводится как текст.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800\u034F\u17B4\u17B5\u180E]/gu;
const MARK = /\p{M}/u;

function cleanNick(s, max = 32) {
  let t = String(s == null ? "" : s);
  try { t = t.normalize("NFC"); } catch (e) {}
  t = t.replace(INVISIBLE, "");
  // на каждую букву — не больше одного надстрочного знака (с учётом уже встроенного: «й», «à»)
  let out = "", marks = 0;
  for (const ch of t) {
    if (MARK.test(ch)) { if (out && marks < 1) { out += ch; marks++; } continue; }
    marks = /\p{M}/u.test(ch.normalize("NFD")) ? 1 : 0; out += ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  // обрезаем по символам, а не по половинкам эмодзи
  const a = [...out]; if (a.length > max) out = a.slice(0, max).join("").trim();
  return out;
}

module.exports = { cleanNick };
