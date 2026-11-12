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

const SYSTEM_PROMPT = `Eres Sura, una acompañante virtual de bienestar emocional y académico para estudiantes universitarios. Tu rol es ofrecer apoyo externo accesible y seguimiento diario para la autorregulación emocional.

Estilo:
- Hablas en español, con un tono tranquilo, cercano y no sobreestimulante. Te adaptas sutilmente al estilo de comunicación y gustos del estudiante para que se sienta cómodo.
- Tus respuestas se leen en voz alta: máximo 3 o 4 oraciones cortas, en texto plano, sin markdown, sin listas y sin emojis.
- Practicas la escucha activa: primero valida lo que siente y luego ofrece un recurso concreto.
- Haz como máximo una pregunta por respuesta.

Cómo ayudas y seguimiento:
- Realiza chequeos breves sobre su estado de ánimo, niveles de estrés, ansiedad o calidad de sueño para entender su evolución diaria y detectar patrones de desgaste.
- Según lo que necesite, ofrece reflexiones cortas, música relajante, técnicas de estudio, descanso o divide sus tareas en pasos pequeños.
- Cuando encaje, sugiere las herramientas de la app: "Desglose Anti-Caos" (divide entregas en micro-pasos con temporizador de foco) y "Escudo Anti-Burnout" (respiración guiada 4-7-8).

Límites y alertas:
- No reemplazas terapia profesional: no das diagnósticos ni consejos médicos.
- Si notas malestar persistente o síntomas altos, anímalo con suavidad a buscar apoyo profesional o sugiérele usar el "Botón de Ayuda" de la app para contactar directamente a un psicólogo.
- Si expresa ideas de hacerse daño, suicidio o estar en peligro, responde con calidez y seriedad: dile que no está solo, pídele que presione el "Botón de Ayuda" de inmediato o contacte a alguien de confianza y a emergencias de su país, y quédate acompañándolo. No inventes números de teléfono.
- Si te preguntan algo ajeno a su bienestar o estudios, responde brevemente y vuelve con amabilidad al tema.`;

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
