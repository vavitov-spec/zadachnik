/**
 * Посредник между Задачником и Claude (через aiprimetech.io).
 * Ключ хранится в переменной окружения ANTHROPIC_API_KEY и наружу не попадает.
 */

const ALLOWED_ORIGINS = [
  'https://vavitov-spec.github.io',
  'http://localhost:8000',
];

// у посредника поддерживаются только короткие имена моделей, без даты в конце
const MODEL = 'claude-sonnet-4-6';

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
  try {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return json({ error: 'Ключ API не задан в настройках воркера' }, 500, cors);

    const { text, projects, today } = await request.json();
    if (!text || !text.trim()) return json({ error: 'Пустая запись' }, 400, cors);

    const projectList = (projects || []).map(p => `- ${p.name} (id: ${p.id})`).join('\n');

    const system = `Ты разбираешь надиктованные рабочие записи строителя и превращаешь их в структурированную запись.

Доступные проекты:
${projectList || '(проектов нет)'}

Сегодня ${today}.

Ответь ТОЛЬКО объектом JSON, без пояснений, с полями:
{
  "type": "task" | "protocol" | "note",
  "projectId": id проекта из списка или null,
  "title": короткая тема,
  "description": подробности или "",
  "dueDate": "ГГГГ-ММ-ДД" или null,
  "time": "ЧЧ:ММ" или null,
  "priority": "high" | "normal" | "low"
}

Правила:
- task — задача, protocol — протокол встречи или решения, note — заметка
- проект определяй по названию, упомянутому в записи; не уверен — null
- "завтра", "в понедельник", "через неделю" переводи в реальную дату от сегодняшней
- priority: high — срочно, normal — важно, low — несрочная мелочь`;

    const upstream = await fetch('https://aiprimetech.io/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: `Запись: "${text}"` }],
      }),
    });

    if (!upstream.ok) {
      const details = await upstream.text();
      return json({ error: 'Сервис ИИ вернул ошибку', details }, 502, cors);
    }

    const data = await upstream.json();
    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    const parsed = extractJson(raw);
    if (!parsed) return json({ error: 'Не удалось разобрать ответ', raw }, 502, cors);

    return json(parsed, 200, cors);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500, cors);
  }
}

// Ответ модели бывает обёрнут в разметку кода или пояснения.
// Берём всё между первой { и последней } — этого достаточно и без поиска обёртки,
// а главное, в исходнике не появляется тройных кавычек, которые ломают копирование.
function extractJson(s) {
  if (!s) return null;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (_) {
    return null;
  }
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
