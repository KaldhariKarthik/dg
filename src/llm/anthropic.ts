/**
 * src/llm/anthropic.ts
 *
 * THE ONLY FILE THAT IMPORTS @anthropic-ai/sdk.
 *
 * Vendor lives here and nowhere else — the same isolation seam Gemini sits
 * behind. The router, orchestrator, agents, synthesizer, and recap all depend
 * on LLMProvider, never on Anthropic. Swapping models or vendors = touch this
 * file and one wiring line in server.ts.
 *
 * Why Claude for the demo: Sonnet 4.6 is materially stronger at the planning,
 * file-reasoning, and tool-calling that make the assistant *look* smart on
 * camera, and Haiku 4.5 is cheap+fast enough to run the router on every turn.
 * Mapping (set in server.ts via the factory):
 *   - router  -> claude-haiku-4-5   ($1/$5  per MTok)
 *   - agents  -> claude-sonnet-4-6  ($3/$15 per MTok, 1M ctx, vision)
 *   - vision  -> claude-sonnet-4-6  (same instance, completeWithImage)
 *
 * Every model call is wrapped in withTimeout so a hung request can't tie up the
 * orchestrator/router/synth/agents. Because everything goes through this
 * provider, one wrap here covers nearly every LLM hang in the system.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
    LLMProvider,
    LLMMessage,
    LLMCompleteOptions,
    LLMVisionOptions,
    LLMImage,
} from "./provider";
import { withTimeout } from "../util/withTimeout";

export interface AnthropicConfig {
    apiKey: string;
    /** Defaults to a fast, cheap model good for most agent work. */
    model?: string;
    /** Hard per-request ceiling in ms. Default 30s. */
    timeoutMs?: number;
    /** Default output cap when a caller doesn't set one. Keeps replies tight. */
    defaultMaxTokens?: number;
}

/** Anthropic requires max_tokens on every request; pick a sane default. */
const DEFAULT_MAX_TOKENS = 1024;

export class AnthropicProvider implements LLMProvider {
    readonly modelId: string;
    private client: Anthropic;
    private timeoutMs: number;
    private defaultMaxTokens: number;

    constructor(cfg: AnthropicConfig) {
        if (!cfg.apiKey) {
            throw new Error("AnthropicProvider: missing apiKey");
        }
        this.client = new Anthropic({ apiKey: cfg.apiKey });
        this.modelId = cfg.model ?? "claude-sonnet-4-6";
        this.timeoutMs = cfg.timeoutMs ?? 30_000;
        this.defaultMaxTokens = cfg.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    }

    async complete(
        messages: LLMMessage[],
        opts?: LLMCompleteOptions
    ): Promise<string> {
        // Our neutral roles map onto Anthropic's shape: system messages become
        // the top-level `system` field; user/model become user/assistant turns.
        const system = messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n\n");

        const turns: Anthropic.MessageParam[] = messages
            .filter((m) => m.role !== "system")
            .map((m) => ({
                role: m.role === "model" ? "assistant" : "user",
                content: m.content,
            }));

        // Anthropic rejects a leading assistant turn and an empty messages list.
        if (turns.length === 0) {
            turns.push({ role: "user", content: "(no input)" });
        }
        if (turns[0].role === "assistant") {
            turns.unshift({ role: "user", content: "(context)" });
        }

        const res = await withTimeout(
            this.client.messages.create({
                model: this.modelId,
                max_tokens: opts?.maxOutputTokens ?? this.defaultMaxTokens,
                temperature: opts?.temperature ?? 0.2,
                ...(system ? { system } : {}),
                messages: turns,
            }),
            this.timeoutMs,
            `Anthropic ${this.modelId}`
        );

        const text = textOf(res);
        if (!text) {
            throw new Error("AnthropicProvider: empty response from model");
        }
        return text;
    }

    async completeWithImage(
        prompt: string,
        image: LLMImage,
        opts?: LLMVisionOptions
    ): Promise<string> {
        const res = await withTimeout(
            this.client.messages.create({
                model: this.modelId,
                max_tokens: opts?.maxOutputTokens ?? this.defaultMaxTokens,
                temperature: opts?.temperature ?? 0.2,
                ...(opts?.system ? { system: opts.system } : {}),
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "image",
                                source: {
                                    type: "base64",
                                    media_type:
                                        image.mimeType as Anthropic.Base64ImageSource["media_type"],
                                    data: image.base64,
                                },
                            },
                            { type: "text", text: prompt },
                        ],
                    },
                ],
            }),
            this.timeoutMs,
            `Anthropic vision ${this.modelId}`
        );

        const text = textOf(res);
        if (!text) {
            throw new Error("AnthropicProvider: empty vision response");
        }
        return text;
    }
}

/** Concatenate all text blocks of a Claude response into one string. */
function textOf(res: Anthropic.Message): string {
    return res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
}
