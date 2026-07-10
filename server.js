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
const SHEETS_WEBHOOK = process.env.SHEETS_WEBHOOK || '';   // URL Google Apps Script → сбор «откуда узнали» в таблицу

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
    '     "psyche": "про психософию (поле психософия — порядок начал В/Л/Э/Ф: воля, логика, эмоция, физика): что для человека первично и как это использовать",',
    '     "ikigai": "про точку пересечения Икигай и куда двигаться",',
    '     "skills": "про готовность к миру ИИ и что развивать",',
    '     "klimov": "про близкий тип профессий (поле климов) и как выбирать",',
    '     "burnout": "про текущее состояние (поле выгорание, 0–100) и что делать"',
    '  },',
    '  "scenarios": [ {"prob":"метка вероятности","title":"заголовок пути","text":"1–2 предложения"} ],',
    '  "summary": "итоговое резюме всего разбора: 2 тёплых абзаца — кто человек в целом по складу, и какие 2–3 профессии из поля топ_профессии подходят ему больше всего и почему именно ему"',
    '}',
    'Каждый комментарий в sys — 2–4 живых предложения, конкретно про ЭТОГО человека по его данным, без общих фраз.',
    'scenarios: ровно 3 элемента, метки вроде «наиболее вероятно», «по душе», «рычаг».',
    'summary — сильный вдохновляющий финал на «вы», который человек прочитает последним.'
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
  ['big5','riasec','base','workstyle','psyche','ikigai','skills','klimov','burnout'].forEach(k => {
    if (sysIn[k]) sys[k] = String(sysIn[k]).trim();
  });
  const out = {
    portrait: String(obj.portrait || '').trim(),
    strengths_text: String(obj.strengths_text || '').trim(),
    archetype2: String(obj.archetype2 || '').trim(),
    summary: String(obj.summary || '').trim(),
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

// ---------- YandexART: персональная «карточка личности» ----------
const YANDEX_ART_MODEL = process.env.YANDEX_ART_MODEL || 'yandex-art/latest';
const CARD_ENABLED = process.env.CARD_IMAGE !== '0'; // выключить картинку целиком: CARD_IMAGE=0
function cardPrompt(profile) {
  // YandexART ограничивает промпт 500 символами — держим коротко
  const a   = profile['архетип_ведущий'] || 'личность';
  const s   = Array.isArray(profile['силы']) ? profile['силы'].slice(0, 2).join(', ') : '';
  const prof= (Array.isArray(profile['топ_профессии']) && profile['топ_профессии'][0]) ? profile['топ_профессии'][0] : '';
  const gender = (profile['пол'] || '').toString().trim();
  const hobby  = (profile['слова'] && profile['слова']['хобби']) ? String(profile['слова']['хобби']).trim().slice(0, 40) : '';
  let p = 'Тёплая современная иллюстрация — портрет-образ личности';
  if (gender) p += ' (' + gender + ')';
  p += ': ' + a;
  if (s)     p += ', ' + s;
  if (hobby) p += '. В образе и на фоне ярко обыграй увлечения человека: ' + hobby;
  if (prof)  p += '. Близка сфера ' + prof;
  p += '. Светлый вдохновляющий стиль, приятные цвета, реалистично, без текста.';
  return p.slice(0, 490);
}
// Картинка разбита на два КОРОТКИХ запроса: отправить задачу и опросить одну операцию.
// Так ни один запрос не живёт по минуте — платформа не убивает процесс за долготу.
async function artSubmit(prompt) {
  const submit = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/imageGenerationAsync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Api-Key ' + YANDEX_API_KEY },
    body: JSON.stringify({
      modelUri: 'art://' + YANDEX_FOLDER_ID + '/' + YANDEX_ART_MODEL,
      generationOptions: { aspectRatio: { widthRatio: '1', heightRatio: '1' } },
      messages: [{ weight: 1, text: prompt }]
    })
  });
  if (!submit.ok) throw new Error('YandexART submit ' + submit.status + ': ' + (await submit.text()));
  const op = await submit.json();
  return op.id;
}
async function artPoll(id) {
  const pr = await fetch('https://llm.api.cloud.yandex.net/operations/' + id, {
    headers: { 'Authorization': 'Api-Key ' + YANDEX_API_KEY }
  });
  if (!pr.ok) throw new Error('YandexART poll ' + pr.status);
  const pd = await pr.json();
  if (!pd.done) return { done: false, image: null };
  if (pd.error) throw new Error('YandexART op: ' + JSON.stringify(pd.error));
  const b64 = pd.response && pd.response.image;
  return { done: true, image: b64 ? ('data:image/jpeg;base64,' + b64) : null };
}
function cardAllowed() {
  return (PROVIDER === 'yandexgpt' && CARD_ENABLED && YANDEX_API_KEY && YANDEX_FOLDER_ID);
}

// ---------- Сбор «откуда узнали» в Google-таблицу ----------
async function sendToSheet(profile) {
  if (!SHEETS_WEBHOOK) return;
  try {
    await fetch(SHEETS_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        дата: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
        источник: profile['источник'] || '',
        трек: profile['трек'] || '',
        пол: profile['пол'] || ''
      })
    });
  } catch (e) { console.error('[SHEET] ошибка:', e.message); }
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
    const JSONH = { 'Content-Type': 'application/json; charset=utf-8' };
    try {
      const profile = JSON.parse(body || '{}');
      const mode = profile.mode || '';

      // === КАРТИНКА: короткий запрос «отправить задачу» → вернуть id операции ===
      if (mode === 'image_submit') {
        if (!cardAllowed()) { res.writeHead(200, JSONH); return res.end('{"opId":""}'); }
        try {
          const opId = await artSubmit(cardPrompt(profile));
          res.writeHead(200, JSONH); return res.end(JSON.stringify({ opId: opId || '' }));
        } catch (e) {
          console.error('[ART] submit ошибка:', e.message);
          res.writeHead(200, JSONH); return res.end('{"opId":""}');
        }
      }
      // === КАРТИНКА: короткий запрос «опросить операцию» → {done, card_image} ===
      if (mode === 'image_poll') {
        try {
          const st = await artPoll(profile.opId);
          res.writeHead(200, JSONH);
          return res.end(JSON.stringify({ done: st.done, card_image: st.image || '' }));
        } catch (e) {
          console.error('[ART] poll ошибка:', e.message);
          res.writeHead(200, JSONH); return res.end('{"done":true,"card_image":""}');
        }
      }

      // === ТЕКСТ: быстрый ответ, без ожидания картинки (её тянет фронт отдельно) ===
      if (profile['источник']) console.log('[SRC] откуда узнали:', profile['источник'], '· трек:', profile['трек'] || '-');
      sendToSheet(profile);   // асинхронно, не тормозит отчёт
      const messages = buildMessages(profile);
      const raw = await callModel(messages);
      const result = coerceResult(raw);
      res.writeHead(200, JSONH);
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
