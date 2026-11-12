const http = require('http');
const fs = require('fs');
const path = require('path');

if (typeof fetch !== 'function') {
    console.error('Necesitas Node.js 18 o superior.');
    process.exit(1);
}

try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (m && !(m[1] in process.env)) {
                process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
            }
        }
    }
} catch (e) {
    console.warn('No pude leer el archivo .env:', e.message);
}

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const HTML_FILE = ['index.html', 'coso_param.html']
    .map(f => path.join(__dirname, f))
    .find(f => fs.existsSync(f)) || path.join(__dirname, 'index.html');

const SYSTEM_PROMPT = `Eres Inteligencia Artificial, una amiga virtual y compañera universitaria. Tu onda es de confianza, relajada y muy humana.

Estilo y tono (SÚPER IMPORTANTE):
- De reconocer alguna tarea dicha por el usuario, recomendar la herramienta "Desglose anti-caos" de manera organica para desglosar en micro pasos los temas de manera mas detallada, o el estudo anti-burnout utilizando el metodo 4-7-8.
- Espejo de lenguaje: Adopta de inmediato el estilo, la jerga, los modismos y el nivel de formalidad (o informalidad) con el que te hable la persona. Si te habla relajado, escríbele igual de casual. Si te escribe corto, no le sueltes un testamento.
- Cero clichés: Evita por completo frases formales de IA o lugares comunes acartonados (como "entre libros y apuntes", "espero que tu día vaya productivo" o discursos motivacionales falsos). Háblale como un pana de verdad.
- Cero interrogatorios obligatorios: No cierres tus mensajes haciendo preguntas de manual si no viene al caso. Si la charla fluye con un consejo, una recomendación o una broma, déjala fluir.

Cómo ayudas:
- Compartes el día a día, escuchas cuando hay estrés o frustración, y das tips de estudio o descanso sin ponerte pesada.
- Equilibrio entre la importancia de salud mental del usuario, y responsabilidad academica. 
- Si te piden recomendaciones (música, bandas, etc.), responde con datos reales y detallados.
- Si encaja orgánicamente, menciona las herramientas de la app como el "Desglose Anti-Caos" o el "Escudo Anti-Burnout".

Límites y alertas:
- EVITA utilizar tipografia tales como: negrita, subrayado, cursiva, entre otros.
- No eres psicóloga ni médica. Si ves que el estrés o la situación es muy pesada, sugiere con tacto buscar apoyo profesional o usar el "Botón de Ayuda" de la app.
- Si la persona menciona sentimientos profundos de tristeza, soledad, crisis o menciona hacerse daño, responde con mucha empatía, valida lo que siente y dile que no tiene que pasar por esto sola.
- IMPORTANTE: Cuando detectes una situación de crisis, invítala amablemente a usar el botón de "Ayuda profesional real" que está en la pantalla, para que hable con un profesional o alguien de confianza. 
- No inventes números de teléfono, solo refiérete al botón o a buscar ayuda en su entorno.`;

const hits = new Map();
function rateLimited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > 25;
}

function sanitizeMessages(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const m of raw.slice(-20)) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
        const content = m.content.trim().slice(0, 2000);
        if (!content) continue;
        const geminiRole = m.role === 'assistant' ? 'model' : 'user';
        const last = out[out.length - 1];
        if (last && last.role === geminiRole) {
            last.parts[0].text += '\n' + content;
        } else {
            out.push({ role: geminiRole, parts: [{ text: content }] });
        }
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
}

function readBody(req, limit = 100_000) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

async function handleChat(req, res) {
    if (!API_KEY) {
        return sendJson(res, 503, { error: 'Falta GEMINI_API_KEY en las variables de entorno o archivo .env.' });
    }
    if (rateLimited(req.socket.remoteAddress || 'local')) {
        return sendJson(res, 429, { error: 'Demasiados mensajes seguidos. Espera un momento.' });
    }

    let payload;
    try {
        payload = JSON.parse(await readBody(req));
    } catch (e) {
        return sendJson(res, e.message === 'too_large' ? 413 : 400, { error: 'Solicitud inválida.' });
    }

    const contents = sanitizeMessages(payload.messages);
    if (!contents.length || contents[contents.length - 1].role !== 'user') {
        return sendJson(res, 400, { error: 'El último mensaje debe ser del usuario.' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);

    try {
        const upstream = await fetch(API_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
            body: JSON.stringify({
                system_instruction: {
                    parts: [{ text: SYSTEM_PROMPT }]
                },
                contents: contents,
                generationConfig: {
                    maxOutputTokens: 800,
                    temperature: 0.7,
                    // Sin "pensamiento" extra: respuestas más rápidas y sin quedarse sin tokens
                    ...(/2\.5-flash/.test(MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
                }
            })
        });

        if (!upstream.ok) {
            const detail = await upstream.text();
            console.error('Error de la API de Gemini:', upstream.status, detail.slice(0, 500));
            return sendJson(res, 502, { error: 'El modelo no respondió.' });
        }

        const data = await upstream.json();
        const parts = data.candidates?.[0]?.content?.parts || [];
        const reply = parts.map(p => p.text || '').join('').trim();

        if (!reply) {
            console.warn('Respuesta vacía. finishReason:', data.candidates?.[0]?.finishReason,
                '| bloqueo:', data.promptFeedback?.blockReason || 'ninguno');
            return sendJson(res, 502, { error: 'Respuesta vacía del modelo.' });
        }
        sendJson(res, 200, { reply });
    } catch (err) {
        console.error('Fallo al llamar a la API:', err.message);
        sendJson(res, 502, { error: 'No pude contactar al modelo.' });
    } finally {
        clearTimeout(timer);
    }
}

const server = http.createServer(async (req, res) => {
    try {
        const url = (req.url || '/').split('?')[0];

        if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/coso_param.html')) {
            const html = fs.readFileSync(HTML_FILE);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        }
        if (req.method === 'POST' && url === '/api/chat') {
            return await handleChat(req, res);
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No encontrado');
    } catch (err) {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Error interno.' });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sura AI lista en http://localhost:${PORT}`);
    console.log(`Modelo Gemini: ${MODEL}`);
    console.log('Página:', path.basename(HTML_FILE), fs.existsSync(HTML_FILE) ? '(encontrada)' : '(NO ENCONTRADA: ponla junto a server.js)');
    if (!API_KEY) console.warn('AVISO: no hay GEMINI_API_KEY. Revisa que tu archivo se llame .env (con punto) y esté junto a server.js.');
});
