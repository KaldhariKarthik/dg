"use strict";
/**
 * src/llm/gemini.ts
 *
 * THE ONLY FILE THAT IMPORTS @google/genai.
 *
 * Vendor lives here and nowhere else. If Google changes their SDK again (they
 * just did — see the migration we went through), this is the single file that
 * changes. Everything upstream depends on LLMProvider, not on Google.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiProvider = void 0;
const genai_1 = require("@google/genai");
class GeminiProvider {
    modelId;
    ai;
    constructor(cfg) {
        if (!cfg.apiKey) {
            throw new Error("GeminiProvider: missing apiKey");
        }
        this.ai = new genai_1.GoogleGenAI({ apiKey: cfg.apiKey });
        this.modelId = cfg.model ?? "gemini-3.5-flash";
    }
    async complete(messages, opts) {
        // Map our neutral messages onto Gemini's request shape.
        // System messages become a systemInstruction; the rest become contents.
        const systemParts = messages
            .filter((m) => m.role === "system")
            .map((m) => m.content);
        const contents = messages
            .filter((m) => m.role !== "system")
            .map((m) => ({
            role: m.role === "model" ? "model" : "user",
            parts: [{ text: m.content }],
        }));
        const response = await this.ai.models.generateContent({
            model: this.modelId,
            contents,
            config: {
                ...(systemParts.length
                    ? { systemInstruction: systemParts.join("\n\n") }
                    : {}),
                temperature: opts?.temperature ?? 0.2,
                ...(opts?.maxOutputTokens
                    ? { maxOutputTokens: opts.maxOutputTokens }
                    : {}),
            },
        });
        const text = response.text;
        if (text === undefined || text === null) {
            throw new Error("GeminiProvider: empty response from model");
        }
        return text;
    }
}
exports.GeminiProvider = GeminiProvider;
//# sourceMappingURL=gemini.js.map