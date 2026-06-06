require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ── Gemini setup ──────────────────────────────────────────────
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
    console.warn('⚠  API_KEY not set — /api/chat and /api/vision will return errors.');
}
const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;

const SYSTEM_INSTRUCTION = `You are DaVinci — a calm, concise, on-device personal AI assistant. 
You help the user plan their day, answer questions, and reason about what they show you through their camera.
Keep replies short (2-4 sentences) unless the user asks for detail. Use a warm, professional tone.`;

// ── POST /api/chat ────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
    if (!genAI) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server.' });

    try {
        const { message, history } = req.body;
        if (!message) return res.status(400).json({ error: 'message is required.' });

        const model = genAI.getGenerativeModel({
            model: 'gemini-3.5-flash',
            systemInstruction: SYSTEM_INSTRUCTION,
        });

        // Build chat with history for multi-turn context
        const chat = model.startChat({
            history: (history || []).map(h => ({
                role: h.role,
                parts: h.parts.map(p => ({ text: p.text })),
            })),
        });

        const result = await chat.sendMessage(message);
        const reply = result.response.text();

        res.json({ reply });
    } catch (err) {
        console.error('Chat error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/vision ──────────────────────────────────────────
const VISION_SYSTEM = `You are DaVinci's vision module. You receive one camera frame plus optional task context,
recent scene summaries, and an optional user transcript. Reply with ONE JSON object and nothing else —
no markdown, no code fences, no prose. Describe only what is actually visible; never invent detail.
Use the task context to judge relevance and to flag expected-but-missing items.

Output exactly this shape:
{
  "task_context": { "task": string, "mode": string },
  "scene": {
    "summary": string,
    "environment": string,
    "objects": [
      { "id": string, "label": string, "state": string, "position": string|null, "confidence": number }
    ],
    "spatial_layout": { "description": string, "dimensions_available": boolean },
    "anomalies": [ { "type": string, "description": string } ]
  },
  "user_flags": { "explicitly_mentioned": string[] }
}

Rules:
- object id: sequential, "obj_01", "obj_02", ...
- confidence: 0..1.
- If the task implies an item that should be present but is absent (e.g. oil while frying),
  include it as an object with state "not detected" and raise an anomaly for it.
- anomalies[].type is one of "warning", "info", "danger". Use [] when nothing is wrong.
- explicitly_mentioned: object labels the user named in their transcript; [] if none.
- If "task" is not provided in context, infer it from the scene. Echo "mode" as given (default "observe").
- Salient objects only. Keep every string short.`;

app.post('/api/vision', async (req, res) => {
    if (!genAI) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server.' });

    try {
        const { image, tier, session_id, task_context, user_transcript, recent, media_meta } = req.body;
        if (!image) return res.status(400).json({ error: 'image is required.' });

        const modelName = tier === 'deep' ? 'gemini-3.5-flash' : 'gemini-3.1-flash-lite';
        const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: VISION_SYSTEM,
            generationConfig: { responseMimeType: 'application/json' },
        });

        const ctxLine =
            `Context — task: ${task_context?.task || 'infer it'}; mode: ${task_context?.mode || 'observe'}; ` +
            `recent: ${(recent || []).filter(Boolean).join(' | ') || 'none'}.`;
        const qLine = user_transcript && user_transcript.trim()
            ? `User transcript: "${user_transcript.trim()}". Note referenced objects in explicitly_mentioned.`
            : 'No user transcript.';

        const prompt = [ctxLine, qLine, 'Return only the JSON object from your instructions.'].join('\n');
        const base64Data = image.replace(/^data:image\/\w+;base64,/, '');

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
        ]);

        const m = normalize(safeParse(result.response.text()));

        // Assemble the v1.0 envelope — model content + server-stamped metadata.
        res.json({
            schema_version: '1.0',
            input_type: 'visual',
            session_id: session_id || null,
            timestamp: new Date().toISOString(),
            task_context: {
                task: task_context?.task || m.task_context.task || 'unknown',
                mode: task_context?.mode || m.task_context.mode || 'observe',
            },
            scene: m.scene,
            user_flags: {
                explicitly_mentioned: m.user_flags.explicitly_mentioned,
                user_transcript: user_transcript || '',
            },
            media_meta: media_meta || {
                source_type: 'video_frame', frame_index: null, resolution: null, capture_device: 'unknown',
            },
            model: modelName,
        });
    } catch (err) {
        console.error('Vision error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

function safeParse(raw) {
    const t = (s) => { try { return JSON.parse(s); } catch { return null; } };
    let o = t(raw) || t(raw.replace(/```json|```/g, '').trim());
    if (!o) { const m = raw.match(/\{[\s\S]*\}/); if (m) o = t(m[0]); }
    return o || { scene: { summary: raw.slice(0, 200) } };
}

// Guarantee every field the contract promises, so the client never breaks.
function normalize(o) {
    const s = o.scene || {};
    const clamp = (n) => (typeof n === 'number' ? Math.max(0, Math.min(1, n)) : 0.5);
    const objects = (Array.isArray(s.objects) ? s.objects : []).map((obj, i) => ({
        id: obj.id || `obj_${String(i + 1).padStart(2, '0')}`,
        label: obj.label || 'unknown',
        state: obj.state || '',
        position: obj.position ?? null,
        confidence: clamp(obj.confidence),
    }));
    const anomalies = (Array.isArray(s.anomalies) ? s.anomalies : []).map((a) => ({
        type: ['warning', 'info', 'danger'].includes(a.type) ? a.type : 'info',
        description: a.description || '',
    }));
    return {
        task_context: {
            task: o.task_context?.task || null,
            mode: o.task_context?.mode || null,
        },
        scene: {
            summary: s.summary || '',
            environment: s.environment || 'unknown',
            objects,
            spatial_layout: {
                description: s.spatial_layout?.description || '',
                dimensions_available: !!s.spatial_layout?.dimensions_available,
            },
            anomalies,
        },
        user_flags: {
            explicitly_mentioned: Array.isArray(o.user_flags?.explicitly_mentioned)
                ? o.user_flags.explicitly_mentioned : [],
        },
    };
}

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`DaVinci server up on http://localhost:${PORT}`));