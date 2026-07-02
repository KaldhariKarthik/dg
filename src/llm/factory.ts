/**
 * src/llm/factory.ts
 *
 * ONE place that decides which vendor and which model backs each role. The rest
 * of the system only ever sees LLMProvider, so this is the single switch for
 * the whole brain.
 *
 * Roles and their defaults (Anthropic is the demo default — strongest at the
 * planning/reasoning that reads well on camera):
 *   - "agent"  -> claude-sonnet-4-6  ($3/$15, 1M ctx, vision) — researcher,
 *                 planner, conversational, vision agent, synthesizer, proactive.
 *   - "router" -> claude-haiku-4-5   ($1/$5, fast) — runs on every turn, so it
 *                 gets the cheap fast model.
 *   - "vision" -> claude-sonnet-4-6  — the raw image->JSON call in /api/vision.
 *
 * Override anything via env without touching code:
 *   LLM_VENDOR=anthropic|gemini      (default: anthropic if ANTHROPIC_API_KEY set)
 *   ANTHROPIC_API_KEY / GEMINI_API_KEY
 *   AGENT_MODEL / ROUTER_MODEL / VISION_MODEL_FAST / VISION_MODEL_DEEP
 */

import { LLMProvider } from "./provider";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";

export type Vendor = "anthropic" | "gemini";

export interface BrainKeys {
    anthropicKey: string;
    geminiKey: string;
}

const DEFAULTS = {
    anthropic: {
        agent: "claude-sonnet-4-6",
        router: "claude-haiku-4-5",
        vision: "claude-sonnet-4-6",
    },
    gemini: {
        agent: "gemini-3.5-flash",
        router: "gemini-3.1-flash-lite",
        vision: "gemini-3.5-flash",
    },
} as const;

export function resolveVendor(keys: BrainKeys): Vendor {
    const explicit = (process.env.LLM_VENDOR ?? "").trim().toLowerCase();
    if (explicit === "anthropic" || explicit === "gemini") return explicit;
    // No explicit choice: prefer Anthropic when its key is present.
    return keys.anthropicKey ? "anthropic" : "gemini";
}

function makeOne(vendor: Vendor, keys: BrainKeys, model: string): LLMProvider {
    if (vendor === "anthropic") {
        return new AnthropicProvider({ apiKey: keys.anthropicKey, model });
    }
    return new GeminiProvider({ apiKey: keys.geminiKey, model });
}

export interface Brain {
    vendor: Vendor;
    /** Backs all the agents + synthesizer + proactive. */
    agent: LLMProvider;
    /** Cheap/fast model for the per-turn router. */
    router: LLMProvider;
    /** Image-capable provider for the /api/vision route. */
    vision: LLMProvider;
}

export function buildBrain(keys: BrainKeys): Brain {
    const vendor = resolveVendor(keys);
    const d = DEFAULTS[vendor];

    const agentModel = (process.env.AGENT_MODEL ?? "").trim() || d.agent;
    const routerModel = (process.env.ROUTER_MODEL ?? "").trim() || d.router;
    const visionModel = (process.env.VISION_MODEL_DEEP ?? "").trim() || d.vision;

    return {
        vendor,
        agent: makeOne(vendor, keys, agentModel),
        router: makeOne(vendor, keys, routerModel),
        vision: makeOne(vendor, keys, visionModel),
    };
}
