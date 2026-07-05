/**
 * Навигатор будущего — AI-бэкенд отчёта.
 *
 * Один endpoint POST / принимает профиль из теста и возвращает
 *   { portrait, strengths_text, scenarios: [{prob,title,text}] }
 * — ровно то, что ждёт фронтенд (enhanceWithAI в файлах отчётов).
 *
 * Мозг переключается одной переменной окружения PROVIDER:
 *   openai | gigachat | yandexgpt
 * Сменить провайдера = поменять PROVIDER и ключ. Код трогать не нужно.
 *
 * Запуск:  PROVIDER=openai OPENAI_API_KEY=sk-... node server.js
 */

const http = require('http');
const crypto = require('crypto');

// ---------- Конфиг из окружения ----------
const PORT           = process.env.PORT || 8080;
const PROVIDER       = (process.env.PROVIDER || 'openai').toLowerCase();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // на проде: https://navigator-prof.ru

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_BASE    = process.env.OPENAI_BASE || 'https://api.openai.com/v1';

// GigaChat (Сбер)
const GIGACHAT_AUTH_KEY = process.env.GIGACHAT_AUTH_KEY || ''; // Authorization key (Base64) из личного кабинета
const GIGACHAT_SCOPE    = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
const GIGACHAT_MODEL    = process.env.GIGACHAT_MODEL || 'GigaChat';
const GIGACHAT_INSECURE = process.env.GIGACHAT_INSECURE === '1'; // 1 = не проверять TLS (если не установлен корневой сертификат Минцифры)
// Надёжный обход TLS для GigaChat: их сертификат подписан корневым Минцифры, которому Node не доверяет по умолчанию.
// При GIGACHAT_INSECURE=1 отключаем проверку сертификата на уровне Node (работает и для fetch/undici).
if (GIGACHAT_INSECURE) { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; }

// YandexGPT
const YANDEX_API_KEY   = process.env.YANDEX_API_KEY || '';
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || '';
const YANDEX_MODEL     = process.env.YANDEX_MODEL || 'yandexgpt/latest';

// ---------- Промпт ----------
function buildMessages(profile) {
  const p = profile || {};
  const track = p['трек'] || 'взрослый';
  const isTeen = /подрост|14|Старт/i.test(track);

  const sys = [
    'Ты — сборная роль лучших в мире специалистов: психолог-профориентолог, карьерный стратег и редактор-копирайтер.',
    'Ты пишешь персональный отчёт для российского сервиса личностной диагностики «Навигатор будущего».',
    '',
    'ЖЁСТКИЕ ПРАВИЛА ЯЗЫКА:',
    '1. Пиши по-русски, тёплым живым языком, обращайся к человеку на «вы».',
    '2. Запрещены отрицательные конструкции с частицей «не» и словами «нет»/«нельзя». Формулируй только утвердительно (вместо «вам не подойдёт рутина» → «вам нужна смена задач и движение»).',
    '3. Принцип асимметрии: предложения и абзацы разной длины, живой человеческий ритм, без канцелярита и клише.',
    '4. Опирайся только на переданные данные профиля. Домыслы и выдуманные факты запрещены.',
    isTeen
      ? '5. Аудитория — подросток 14–17 лет и его родители. Тон бережный, вдохновляющий, про школу, интересы и поступление, без корпоративного жаргона.'
      : '5. Аудитория — взрослый человек. Тон уважительный, конкретный, по делу.',
    '',
    'ФОРМАТ ОТВЕТА: строго один JSON-объект, без markdown и пояснений, со схемой:',
    '{',
    '  "portrait": "3–4 абзаца цельного портрета личности, разделённые пустой строкой",',
    '  "strengths_text": "1 короткий абзац о сильных сторонах и как их применять",',
    '  "archetype2": "1 абзац про второй ведущий архетип человека (поле архетип_второй) — что он добавляет и как сочетается с ведущим",',
    '  "sys": {',
    '     "big5": "детальная персональная расшифровка черт характера этого человека и что с ними делать",',
    '     "riasec": "расшифровка профессионального кода и где он раскроется",',
    '     "base": "про сильные стороны, мотивацию и ценности — как на них опираться",',
    '     "workstyle": "про рабочий стиль и роль в команде",',
    '     "ikigai": "про точку пересечения Икигай и куда двигаться",',
    '     "skills": "про готовность к миру ИИ и что развивать",',
    '     "klimov": "про близкий тип профессий (поле климов) и как выбирать",',
    '     "burnout": "про текущее состояние (поле выгорание, 0–100) и что делать"',
    '  },',
    '  "scenarios": [ {"prob":"метка вероятности","title":"заголовок пути","text":"1–2 предложения"} ]',
    '}',
    'Каждый комментарий в sys — 2–4 живых предложения, конкретно про ЭТОГО человека по его данным, без общих фраз.',
    'scenarios: ровно 3 элемента, метки вроде «наиболее вероятно», «по душе», «рычаг».'
  ].join('\n');

  const usr = 'Данные профиля человека (результат диагностики по 12 методикам):\n' +
    JSON.stringify(profile, null, 2) +
    '\n\nСобери отчёт по правилам и верни только JSON.';

  return [
    { role: 'system', content: sys },
    { role: 'user',   content: usr }
  ];
}

// ---------- Разбор и валидация ответа модели ----------
function coerceResult(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    obj = JSON.parse(s >= 0 ? raw.slice(s, e + 1) : raw);
  }
  const sysIn = (obj.sys && typeof obj.sys === 'object') ? obj.sys : {};
  const sys = {};
  ['big5','riasec','base','workstyle','ikigai','skills','klimov','burnout'].forEach(k => {
    if (sysIn[k]) sys[k] = String(sysIn[k]).trim();
  });
  const out = {
    portrait: String(obj.portrait || '').trim(),
    strengths_text: String(obj.strengths_text || '').trim(),
    archetype2: String(obj.archetype2 || '').trim(),
    sys,
    scenarios: Array.isArray(obj.scenarios) ? obj.scenarios.slice(0, 3).map(s => ({
      prob:  String(s.prob  || '').trim(),
      title: String(s.title || '').trim(),
      text:  String(s.text  || '').trim()
    })) : []
  };
  if (!out.portrait) throw new Error('empty portrait');
  return out;
}

// ================= Провайдеры =================

// ---- OpenAI ----
async function callOpenAI(messages) {
  const r = await fetch(OPENAI_BASE + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI_API_KEY
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.8,
      response_format: { type: 'json_object' },
      messages
    })
  });
  if (!r.ok) throw new Error('OpenAI ' + r.status + ': ' + (await r.text()));
  const data = await r.json();
  return data.choices[0].message.content;
}

// ---- GigaChat (Сбер): сначала OAuth-токен, потом запрос ----
let _giga = { token: null, exp: 0 };
function gigaDispatcher() {
  if (!GIGACHAT_INSECURE) return undefined;
  try {
    const { Agent } = require('undici');
    return new Agent({ connect: { rejectUnauthorized: false } });
  } catch (_) { return undefined; }
}
async function gigaToken() {
  if (_giga.token && Date.now() < _giga.exp - 30000) return _giga.token;
  const r = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'RqUID': crypto.randomUUID(),
      'Authorization': 'Basic ' + GIGACHAT_AUTH_KEY
    },
    body: 'scope=' + encodeURIComponent(GIGACHAT_SCOPE),
    dispatcher: gigaDispatcher()
  });
  if (!r.ok) throw new Error('GigaChat OAuth ' + r.status + ': ' + (await r.text()));
  const d = await r.json();
  _giga = { token: d.access_token, exp: d.expires_at || (Date.now() + 25 * 60 * 1000) };
  return _giga.token;
}
async function callGigaChat(messages) {
  const token = await gigaToken();
  const r = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({ model: GIGACHAT_MODEL, temperature: 0.8, messages }),
    dispatcher: gigaDispatcher()
  });
  if (!r.ok) throw new Error('GigaChat ' + r.status + ': ' + (await r.text()));
  const d = await r.json();
  return d.choices[0].message.content;
}

// ---- YandexGPT ----
async function callYandexGPT(messages) {
  const r = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Api-Key ' + YANDEX_API_KEY
    },
    body: JSON.stringify({
      modelUri: 'gpt://' + YANDEX_FOLDER_ID + '/' + YANDEX_MODEL,
      completionOptions: { stream: false, temperature: 0.8, maxTokens: 2000 },
      messages: messages.map(m => ({ role: m.role, text: m.content }))
    })
  });
  if (!r.ok) throw new Error('YandexGPT ' + r.status + ': ' + (await r.text()));
  const d = await r.json();
  return d.result.alternatives[0].message.text;
}

async function callModel(messages) {
  if (PROVIDER === 'openai')    return callOpenAI(messages);
  if (PROVIDER === 'gigachat')  return callGigaChat(messages);
  if (PROVIDER === 'yandexgpt') return callYandexGPT(messages);
  throw new Error('Неизвестный PROVIDER: ' + PROVIDER);
}

// ---------- HTTP-сервер ----------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET') { res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'}); return res.end('Навигатор AI-бэкенд · провайдер: ' + PROVIDER + ' · OK'); }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const profile = JSON.parse(body || '{}');
      const messages = buildMessages(profile);
      const raw = await callModel(messages);
      const result = coerceResult(raw);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[AI] ошибка:', e.message);
      // 502 → фронтенд корректно откатится на шаблонный отчёт (enhanceWithAI вернёт null)
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log('Навигатор AI-бэкенд запущен на :' + PORT + ' · провайдер: ' + PROVIDER);
});
