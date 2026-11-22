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
const passArt = fs.readFileSync(path.join(__dirname, "../../assets/winter-ops-card.avif"));
assert.ok(passArt.length > 10000, "Winter Ops card is missing or unusually small");
assert.equal(passArt.toString("ascii", 4, 8), "ftyp", "Winter Ops card must be a valid ISO-BMFF/AVIF container");
assert.match(html, /assets\/winter-ops-card\.avif/, "Pass must reference its bundled card image");
assert.match(html, /ps-scene-visual/, "Pass must have a dedicated hero-art layout");
assert.match(html, /ps-c-icon/, "Reward cards must contain styled icon containers");
assert.match(html, /@media\(max-width:620px\)/, "Pass must define phone layout rules");

assert.match(html, /class="ps-scene"/, "Сезонный кинематографичный блок должен присутствовать");
assert.match(html, /id="psRewards"/, "Секция реальных наград должна иметь якорь");
assert.match(html, /data-psfilter="premium"/, "Премиум-фильтр должен быть подключён");
assert.match(html, /data-psfilter="free"/, "Бесплатный фильтр должен быть подключён");
assert.match(html, /id="psJumpRewards"/, "Переход к наградам должен быть рабочей кнопкой");
assert.match(html, /id="psBuy"/, "Покупка пропуска должна оставаться доступна");
assert.match(html, /data-psclaim/, "Получение наград не должно быть удалено");
assert.match(html, /psWindowSet/, "Навигация по уровням должна работать");
assert.match(html, /data:image\/webp;base64,/, "Зимний фон должен быть реально встроен");

const avifMatch=html.match(/data:image\/avif;base64,([A-Za-z0-9+/=]{10000,})/);
const sceneMatch=html.match(/data:image\/webp;base64,([A-Za-z0-9+/=]{5000,})/);
assert.ok(avifMatch,"Изображение Winter Ops действительно встроено");
assert.ok(sceneMatch,"Фотофоновое изображение Winter Ops действительно встроено");
const avif=Buffer.from(avifMatch[1],"base64");
const webp=Buffer.from(sceneMatch[1],"base64");
assert.equal(avif.toString("ascii",4,8),"ftyp","Карточка должна содержать настоящий AVIF-файл");
assert.equal(webp.toString("ascii",0,4),"RIFF","Фон должен содержать настоящий WebP-файл");
assert.equal(webp.toString("ascii",8,12),"WEBP","Фон должен декодироваться как WebP");

const portrait = html.match(/<img src="([^"]+)" alt="TASHER Winter Ops/);
assert.ok(portrait, "Карточка Winter Ops должна быть в разметке");
assert.ok(portrait[1].startsWith("data:image/avif;base64,") && portrait[1].length > 20000, "Используется именно утверждённое изображение из макета, встроенное без сетевых зависимостей");
assert.match(html, /<h1>Боевой пропуск <em>Winter Ops<\/em><\/h1>/, "У сезонной страницы должен быть один главный заголовок");
if (!portrait[1].startsWith("data:image/")) {
  const rel = portrait[1].replace(/^\/+/,"");
  assert.ok(!rel.includes("..") && fs.existsSync(path.join(__dirname,"../..",rel)), "Файл изображения пропуска должен существовать в репозитории");
}

console.log(`Frontend: ${scripts.length} inline JS block(s) parsed; UPD smoke checks passed`);
