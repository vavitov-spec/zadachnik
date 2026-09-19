/**
 * Посредник между Задачником и нейросетью.
 *
 * Основная модель — Alice AI в Yandex AI Studio: отвечает за доли секунды,
 * работает из России без блокировок. Если она недоступна, запрос уходит
 * к Claude через aiprimetech.io — тот медленнее, но остаётся страховкой.
 *
 * Ключи лежат в переменных окружения воркера и наружу не попадают:
 *   YANDEX_API_KEY, YANDEX_FOLDER_ID, ANTHROPIC_API_KEY
 */

const ALLOWED_ORIGINS = [
  'https://vavitov-spec.github.io',
  'http://localhost:8000',
];

// Flash доступна только по OpenAI-совместимому пути; в тесте на 15 надиктовках
// дала те же 0 промахов, что и старшая модель, но стоит впятеро дешевле.
const YANDEX_URL = 'https://llm.api.cloud.yandex.net/v1/chat/completions';
const YANDEX_MODEL = 'aliceai-llm-flash';

const CLAUDE_URL = 'https://aiprimetech.io/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';   // только короткие имена, без даты

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

    const url = new URL(request.url);
    if (url.pathname !== '/api/parse-voice') {
      return new Response('Not found', { status: 404, headers: cors });
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'Запрос с чужого адреса' }, 403, cors);
    }

    return handleParseVoice(request, env, cors);
  },
};

async function handleParseVoice(request, env, cors) {
  let text, projects, today;
  try {
    const body = await request.json();
    text = body.text;
    projects = body.projects;
    today = body.today;
  } catch (e) {
    return json({ error: 'Не разобрал запрос' }, 400, cors);
  }
  if (!text || !text.trim()) return json({ error: 'Пустая запись' }, 400, cors);

  const system = buildSystemPrompt(projects, today);
  const user = 'Запись: "' + expandAbbr(text.trim()) + '"';
  const errors = [];

  // 1. Быстрый путь — Alice AI
  if (env.YANDEX_API_KEY && env.YANDEX_FOLDER_ID) {
    try {
      const parsed = await askYandex(env, system, user);
      if (parsed) return json({ ...parsed, via: 'alice' }, 200, cors);
      errors.push('Alice AI: ответ не разобран (возможно, цензурный фильтр)');
    } catch (e) {
      errors.push('Alice AI: ' + shortErr(e));
    }
  } else {
    errors.push('Alice AI пропущена: не заданы YANDEX_API_KEY и YANDEX_FOLDER_ID');
  }

  // 2. Запасной путь — Claude
  if (env.ANTHROPIC_API_KEY) {
    try {
      const parsed = await askClaude(env, system, user);
      // via показывает, кто ответил, и почему не сработал быстрый путь
      if (parsed) return json({ ...parsed, via: 'claude', fallback: errors.join('; ') }, 200, cors);
      errors.push('Claude: ответ не разобран');
    } catch (e) {
      errors.push('Claude: ' + shortErr(e));
    }
  }

  return json({ error: 'Разобрать не удалось', details: errors.join('; ') }, 502, cors);
}

/* ---------- Задание для модели ---------- */

// Явные даты и разбор типа записи подняли точность: без них модели путали
// предстоящий созвон с протоколом совещания и ошибались в «в понедельник».
function buildSystemPrompt(projects, today) {
  const DOW = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const base = today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? new Date(today + 'T00:00:00Z') : new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const plus = (n) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + n); return d; };

  const list = (projects || []).map(p => '- ' + p.name + ' (id: ' + p.id + ')').join('\n');

  return [
    'Ты разбираешь надиктованные рабочие записи строителя.',
    '',
    'Доступные проекты:',
    list || '(проектов нет)',
    '',
    'Календарь (даты бери только отсюда):',
    calendar(base),
    '',
    'Ответь ТОЛЬКО объектом JSON, без пояснений, с полями:',
    '{"type":"task|protocol|note","projectId":"id или null","title":"короткая тема",',
    ' "description":"подробности или пустая строка","dueDate":"ГГГГ-ММ-ДД или null",',
    ' "time":"ЧЧ:ММ или null","priority":"high|normal|low"}',
    '',
    'Как различать тип:',
    '- task — то, что НАДО СДЕЛАТЬ: поручение, звонок, согласование, предстоящая',
    '  встреча или созвон. Если событие ещё впереди, это task, а не protocol.',
    '- protocol — запись УЖЕ СОСТОЯВШЕГОСЯ совещания: что обсудили и что решили.',
    '  Признаки: "решили", "договорились", "обсудили", само слово "протокол".',
    '- note — просто мысль или сведение, делать ничего не надо.',
    '',
    'Верни РОВНО ОДИН объект, не массив. Если в записи и сделанное, и',
    'предстоящее — главное это предстоящее: тип task, сделанное уйдёт в описание.',
    'Проект определяй по названию из записи; не уверен — null.',
    'Даты считай от сегодняшней. Если дата не названа, ставь null.',
    'priority: high — срочно, normal — важно, low — несрочная мелочь.',
  ].join('\n');
}

/* ---------- Обращения к моделям ---------- */

async function askYandex(env, system, user) {
  const r = await fetch(YANDEX_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Api-Key ' + env.YANDEX_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt://' + env.YANDEX_FOLDER_ID + '/' + YANDEX_MODEL,
      temperature: 0,
      max_tokens: 500,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  const txt = d && d.choices && d.choices[0] ? d.choices[0].message.content : '';
  return extractJson(txt);
}

async function askClaude(env, system, user) {
  const r = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return extractJson(txt);
}

/* ---------- Мелочи ---------- */

// Ответ бывает обёрнут в разметку кода или пояснения, а на составной записи
// («смонтировали то-то, в среду проверить то-то») модель возвращает массив из
// нескольких записей. Разбираем оба случая.
function extractJson(s) {
  const value = firstJsonValue(s);
  if (!value) return null;
  if (Array.isArray(value)) {
    // из нескольких берём дело: незакрытая задача важнее записи о сделанном
    const task = value.filter(x => x && x.type === 'task')[0];
    return task || value[0] || null;
  }
  return value;
}

// Первое сбалансированное значение JSON в тексте. Скобки внутри строк
// не считаем, иначе описание с фигурной скобкой ломало бы разбор.
function firstJsonValue(s) {
  if (!s) return null;
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) {
        try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { break; }
      }
    }
  }
  return null;
}

// Без таблицы дат модель хватается за первую попавшуюся дату из задания
// и путает «послезавтра», «в среду», «во вторник».
function calendar(base) {
  const DOW = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const MARK = { 0: ' — сегодня', 1: ' — завтра', 2: ' — послезавтра', 7: ' — через неделю' };
  const rows = [];
  for (let k = 0; k < 15; k++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + k);
    rows.push(d.toISOString().slice(0, 10) + ' ' + DOW[d.getUTCDay()] + (MARK[k] || ''));
  }
  return rows.join('\n');
}

// Цензурный фильтр Яндекса отказывается обрабатывать сокращение НВФ —
// проверено, отказ приходит даже на одно это слово. Разворачиваем в полное
// название: смысл тот же, запись проходит.
// \b в JavaScript считает словом только латиницу, с кириллицей не работает —
// поэтому границы задаём явно через просмотр по сторонам.
const RU = 'А-Яа-яЁёA-Za-z';
const ABBR = [
  [new RegExp('(?<![' + RU + '])НВФ(?![' + RU + '])', 'gi'), 'навесной вентилируемый фасад'],
];

function expandAbbr(t) {
  let out = t;
  for (const [rx, full] of ABBR) out = out.replace(rx, full);
  return out;
}

function shortErr(e) {
  return String((e && e.message) || e).slice(0, 200);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
