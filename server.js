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
    if (!genAI) return res.status(500).json({ error: 'API_KEY not configured on server.' });

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
app.post('/api/vision', async (req, res) => {
    if (!genAI) return res.status(500).json({ error: 'API_KEY not configured on server.' });

    try {
        const { image, question } = req.body;
        if (!image) return res.status(400).json({ error: 'image is required.' });

        const model = genAI.getGenerativeModel({
            model: 'gemini-3-pro-preview',
            systemInstruction: SYSTEM_INSTRUCTION,
        });

        // Strip data-url prefix to get raw base64
        const base64Data = image.replace(/^data:image\/\w+;base64,/, '');

        const prompt = question && question.trim()
            ? question.trim()
            : 'Describe what you see in this image concisely. If there is text, read it. If there are objects, identify them.';

        const result = await model.generateContent([
            { text: prompt },
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64Data,
                },
            },
        ]);

        const reply = result.response.text();
        res.json({ reply });
    } catch (err) {
        console.error('Vision error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`DaVinci server up on http://localhost:${PORT}`));