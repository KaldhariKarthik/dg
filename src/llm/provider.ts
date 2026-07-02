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
    /**
     * Ask the model to return strict JSON. Implementors should set the vendor's
     * JSON/response-format flag where one exists, and ALWAYS the system prompt
     * should still instruct "JSON only" as the portable guarantee.
     */
    json?: boolean;
}

/** A base64 image (no data: prefix) plus its mime type. */
export interface LLMImage {
    /** Raw base64 — strip any `data:image/...;base64,` prefix before passing. */
    base64: string;
    /** e.g. "image/jpeg", "image/png". */
    mimeType: string;
}

export interface LLMVisionOptions extends LLMCompleteOptions {
    /** Optional system instruction for the vision call. */
    system?: string;
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

    /**
     * OPTIONAL multimodal call: one text prompt + one image, text out.
     * Implementors that can see images expose this; callers MUST feature-detect
     * (`if (provider.completeWithImage) ...`) and fall back when it's absent.
     * Deliberately single-image + text to stay the lowest common denominator
     * across vendors; the vision route never needs a conversation here.
     */
    completeWithImage?(
        prompt: string,
        image: LLMImage,
        opts?: LLMVisionOptions
    ): Promise<string>;
}