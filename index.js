require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Session store: sessionId -> message history
const sessions = new Map();

const SYSTEM_PROMPT = `Eres un asistente amable de registro médico. Tu única tarea es recopilar conversacionalmente estos 4 datos del paciente:
- nombre (nombre completo)
- fecha_nacimiento (fecha de nacimiento)
- edad (edad actual en años, número entero)
- diagnostico (diagnóstico médico)

Reglas estrictas:
1. Haz UNA sola pregunta a la vez. Empieza siempre preguntando el nombre.
2. Confirma brevemente cada respuesta antes de pasar a la siguiente pregunta (ej: "Perfecto, anotado.").
3. Cuando tengas los 4 datos completos, llama INMEDIATAMENTE la herramienta save_patient. No preguntes confirmación al usuario.
4. Para fecha_nacimiento convierte la respuesta del usuario a formato YYYY-MM-DD antes de guardar.
5. Responde siempre en español con mensajes cortos y cálidos.
6. Si el usuario saluda, saluda brevemente y pregunta de inmediato el nombre.`;

const tools = [
  {
    name: 'save_patient',
    description: 'Guarda los datos del paciente en PostgreSQL cuando los 4 campos están completos',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre completo del paciente' },
        fecha_nacimiento: { type: 'string', description: 'Fecha de nacimiento en formato YYYY-MM-DD' },
        edad: { type: 'integer', description: 'Edad del paciente en años' },
        diagnostico: { type: 'string', description: 'Diagnóstico médico del paciente' },
      },
      required: ['nombre', 'fecha_nacimiento', 'edad', 'diagnostico'],
    },
  },
];

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join('=').trim())])
  );
}

// Creates the patients table if it doesn't exist
app.get('/setup', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id            SERIAL PRIMARY KEY,
        nombre        TEXT,
        fecha_nacimiento DATE,
        edad          INT,
        diagnostico   TEXT,
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    res.json({ ok: true, message: 'Tabla patients lista.' });
  } catch (err) {
    console.error('Setup error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  let sessionId = cookies.sessionId;

  if (!sessionId || !sessions.has(sessionId)) {
    sessionId = crypto.randomUUID();
    sessions.set(sessionId, []);
  }

  const history = sessions.get(sessionId);
  const userMsg = (req.body.message || '').trim();

  if (!userMsg) {
    if (history.length === 0) {
      // New session: synthetic greeting to get Claude to introduce itself
      history.push({ role: 'user', content: 'hola' });
    } else {
      // Existing session + empty message (page reload): skip API call,
      // the history is intact and the next real message will continue it
      res.setHeader('Set-Cookie', `sessionId=${sessionId}; HttpOnly; Path=/; SameSite=Lax`);
      return res.json({ reply: '' });
    }
  } else {
    history.push({ role: 'user', content: userMsg });
  }

  try {
    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools,
      messages: history,
    });

    let replyText = '';
    let patientSaved = false;

    // Agentic loop: keep going while Claude wants to use tools
    while (response.stop_reason === 'tool_use') {
      const toolUse = response.content.find((b) => b.type === 'tool_use');
      if (!toolUse || toolUse.name !== 'save_patient') break;

      // Append Claude's tool-use turn to history
      history.push({ role: 'assistant', content: response.content });

      let toolResult;
      try {
        const { rows } = await pool.query(
          'INSERT INTO patients (nombre, fecha_nacimiento, edad, diagnostico) VALUES ($1, $2, $3, $4) RETURNING id',
          [
            toolUse.input.nombre,
            toolUse.input.fecha_nacimiento,
            toolUse.input.edad,
            toolUse.input.diagnostico,
          ]
        );
        toolResult = `Paciente guardado exitosamente con ID ${rows[0].id}.`;
        patientSaved = true;
      } catch (dbErr) {
        console.error('DB error:', dbErr.message);
        toolResult = `Error al guardar: ${dbErr.message}`;
      }

      history.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }],
      });

      // Get Claude's confirmation message after tool result
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        tools,
        messages: history,
      });
    }

    replyText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (patientSaved) {
      // Reset session so next message starts a fresh intake
      sessions.set(sessionId, []);
    } else {
      history.push({ role: 'assistant', content: replyText });
    }

    res.setHeader('Set-Cookie', `sessionId=${sessionId}; HttpOnly; Path=/; SameSite=Lax`);
    res.json({ reply: replyText });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Registro de Pacientes</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }

    .card {
      width: 100%;
      max-width: 600px;
      height: 88vh;
      background: #ffffff;
      border-radius: 18px;
      box-shadow: 0 6px 32px rgba(0, 0, 0, 0.10);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    header {
      background: #1e40af;
      padding: 18px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    header .icon {
      width: 36px; height: 36px;
      background: rgba(255,255,255,0.18);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
    }
    header .title { color: #fff; font-size: 15px; font-weight: 600; }
    header .sub { color: rgba(255,255,255,0.65); font-size: 12px; margin-top: 1px; }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scroll-behavior: smooth;
    }

    .bubble {
      max-width: 78%;
      padding: 11px 15px;
      border-radius: 16px;
      font-size: 14px;
      line-height: 1.6;
      word-break: break-word;
    }
    .bubble.bot {
      background: #f1f5f9;
      color: #1e293b;
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .bubble.user {
      background: #1e40af;
      color: #ffffff;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }

    .typing {
      display: flex;
      gap: 5px;
      align-items: center;
      padding: 12px 15px;
      background: #f1f5f9;
      border-radius: 16px;
      border-bottom-left-radius: 4px;
      align-self: flex-start;
      width: fit-content;
    }
    .dot {
      width: 7px; height: 7px;
      background: #94a3b8;
      border-radius: 50%;
      animation: blink 1.3s ease-in-out infinite;
    }
    .dot:nth-child(2) { animation-delay: 0.22s; }
    .dot:nth-child(3) { animation-delay: 0.44s; }
    @keyframes blink {
      0%, 100% { opacity: 0.3; transform: translateY(0); }
      50%       { opacity: 1;   transform: translateY(-4px); }
    }

    .input-area {
      padding: 14px 18px;
      border-top: 1px solid #e2e8f0;
      display: flex;
      gap: 10px;
      background: #fff;
    }
    input[type=text] {
      flex: 1;
      padding: 11px 15px;
      border: 1.5px solid #cbd5e1;
      border-radius: 10px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
      color: #1e293b;
    }
    input[type=text]:focus { border-color: #1e40af; }
    input[type=text]::placeholder { color: #94a3b8; }

    button {
      padding: 11px 22px;
      background: #1e40af;
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;
    }
    button:hover:not(:disabled) { background: #1e3a8a; }
    button:disabled { background: #93c5fd; cursor: default; }
  </style>
</head>
<body>
<div class="card">
  <header>
    <div class="icon">🏥</div>
    <div>
      <div class="title">Registro de Pacientes</div>
      <div class="sub">Asistente médico conversacional</div>
    </div>
  </header>

  <div class="messages" id="msgs"></div>

  <div class="input-area">
    <input type="text" id="inp" placeholder="Escribe tu respuesta..." autocomplete="off" />
    <button id="btn" onclick="send()">Enviar</button>
  </div>
</div>

<script>
  const msgs = document.getElementById('msgs');
  const inp  = document.getElementById('inp');
  const btn  = document.getElementById('btn');

  function addBubble(text, role) {
    const d = document.createElement('div');
    d.className = 'bubble ' + role;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function showTyping() {
    const d = document.createElement('div');
    d.className = 'typing';
    d.id = 'typing';
    d.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function hideTyping() {
    document.getElementById('typing')?.remove();
  }

  async function callChat(message) {
    btn.disabled = true;
    inp.disabled = true;
    showTyping();
    try {
      const r = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        credentials: 'same-origin',
      });
      const data = await r.json();
      hideTyping();
      if (data.reply) addBubble(data.reply, 'bot');
      else if (data.error) addBubble('Error: ' + data.error, 'bot');
    } catch {
      hideTyping();
      addBubble('Error de conexión. Intenta de nuevo.', 'bot');
    }
    btn.disabled = false;
    inp.disabled = false;
    inp.focus();
  }

  async function send() {
    const text = inp.value.trim();
    if (!text || btn.disabled) return;
    addBubble(text, 'user');
    inp.value = '';
    await callChat(text);
  }

  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  // Auto-start: get initial greeting from Claude
  callChat('');
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
  console.log(`Ejecuta GET http://localhost:${PORT}/setup para crear la tabla patients`);
});
