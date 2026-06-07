/**
 * src/llm/provider.ts
 *
 * The vendor-neutral model interface.
 *
 * Nothing in the system talks to Gemini directly except the one file that
 * implements this. Everything else depends on THIS interface. Swap Gemini for
 * OpenAI/Claude/local later = write one new implementor, change one wiring
 * line. The router, orchestrator, and agents never know which model is behind
 * it. That is the vendor-isolation seam.
 */

/** A single chat message in a vendor-neutral shape. */
export interface LLMMessage {
    role: "system" | "user" | "model";
    content: string;
}

export interface LLMCompleteOptions {
    /** Lower = more deterministic. Routing wants low temperature. */
    temperature?: number;
    /** Optional cap on output length. */
    maxOutputTokens?: number;
}

export interface LLMProvider {
    /** Human-readable id of the underlying model, for logging. */
    readonly modelId: string;
    /**
     * Send messages, get back the model's text. Plain text in, plain text out
     * — deliberately minimal so any vendor can satisfy it. Structured decisions
     * (like routing) are done by prompting for JSON and parsing the text.
     */
    complete(
        messages: LLMMessage[],
        opts?: LLMCompleteOptions
    ): Promise<string>;
}