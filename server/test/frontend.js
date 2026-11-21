"use strict";
// Проверяем синтаксис монолитного inline-JS и видимые требования UPD без запуска браузера.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
assert.ok(scripts.length, "В index.html должен быть inline-JavaScript");
for (const [i, match] of scripts.entries()) {
  new vm.Script(match[1], { filename: `index.html:inline-${i+1}` });
}
assert.ok(!html.includes('id="lgBox"'), "Таблица лиг должна быть убрана с сайта");
assert.ok(!html.includes('${clanTag(p)}${lgChip(p)}'), "Лиги не должны выводиться в строках рейтинга");
assert.match(html, /#admTabs \[data-t="ev"\].*display:none!important/, "Вкладка событий должна быть скрыта");
assert.match(html, /TASHER UPD — arena-style battle pass/, "Боевой пропуск должен получить новый дизайн");
assert.match(html, /\$\{esc\(m\)\}<small>/, "Имя карты экранируется при вставке в HTML");
console.log(`Frontend: ${scripts.length} inline JS block(s) parsed; UPD smoke checks passed`);
