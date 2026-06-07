/**
 * ============================================================================
 *  core/types.ts  —  THE CONTRACT ("the socket")
 * ============================================================================
 *
 *  This file is the single most important file in the project.
 *
 *  Everything else (orchestrator, researcher, planner, executor, future vision
 *  agent, the model provider, the adapters) is REPLACEABLE. This file is not.
 *
 *  The rule:
 *    - Editing an agent's internal logic        -> fine, do it daily.
 *    - Editing the shapes in THIS file          -> rare, deliberate, versioned.
 *
 *  Why: as long as every agent speaks these exact shapes, you can rewrite,
 *  swap, or add agents without anything else noticing. That is the
 *  "change 1 thing != break the system" property. It lives here.
 *
 *  When you genuinely must change a shape, bump CONTRACT_VERSION and treat it
 *  as a migration, not a casual edit.
 * ============================================================================
 */

export const CONTRACT_VERSION = "1.0" as const;

/* ----------------------------------------------------------------------------
 *  WHO can be an agent.
 *  Adding a new agent later (e.g. "vision") = add one entry here, write one
 *  file that implements `Agent`. Nothing else changes. That is horizontal
 *  growth being cheap.
 * ------------------------------------------------------------------------- */
export type AgentName =
    | "orchestrator"
    | "researcher"
    | "planner"
    | "executor";
// future: | "vision" | ...

/* ----------------------------------------------------------------------------
 *  INPUT — what the user/orchestrator hands to an agent.
 *
 *  A discriminated union on `kind`:
 *    - text  : plain English (text or voice-transcribed). Most requests.
 *    - scene : the rich structured object, ONLY for vision-based input.
 *
 *  Adding "voice" later is free: voice transcribes to text, so it reuses
 *  TextInput. Adding a new modality = add a member here.
 * ------------------------------------------------------------------------- */
export interface TextInput {
    kind: "text";
    text: string;
}

export interface SceneInput {
    kind: "scene";
    /**
     * The vision pipeline's structured scene object (the JSON with scene,
     * objects, anomalies, etc.). Kept as `unknown` deliberately: the contract
     * does not freeze the scene's internal shape, so the vision pipeline can
     * evolve its schema independently without touching this file. The vision
     * agent is responsible for validating it.
     */
    scene: unknown;
    /** Optional accompanying utterance, if the user also spoke/typed. */
    text?: string;
}

export type AgentInput = TextInput | SceneInput;

/* ----------------------------------------------------------------------------
 *  CONTEXT — everything an agent needs to know that isn't the input itself.
 *
 *  This rides alongside every request. Session id ties a conversation
 *  together; `state` is the persisted bag the planner reads/writes to track
 *  progress across requests. `history` is prior turns the orchestrator chooses
 *  to expose. Kept small on purpose.
 * ------------------------------------------------------------------------- */
export interface Context {
    sessionId: string;
    /**
     * Persisted session state. The planner writes progress here; any agent may
     * read it. Loaded from the Store before a request, saved after. Treated as
     * an opaque bag so agents can store what they need without a schema change.
     */
    state: Record<string, unknown>;
    /** Prior turns, oldest first, that the orchestrator decided to surface. */
    history: Turn[];
    /** When this request started — useful for timeouts/tracing later. */
    startedAt: string; // ISO timestamp
}

export interface Turn {
    role: "user" | AgentName;
    /** Human-readable summary of what was said/done on this turn. */
    message: string;
    at: string; // ISO timestamp
}

/* ----------------------------------------------------------------------------
 *  REQUEST — the full envelope handed to an agent's handle().
 * ------------------------------------------------------------------------- */
export interface AgentRequest {
    /** Sanity guard: which contract version produced this. */
    contractVersion: typeof CONTRACT_VERSION;
    input: AgentInput;
}

/* ----------------------------------------------------------------------------
 *  RESPONSE — what every agent MUST hand back. The richer shape, because you
 *  want a high ceiling:
 *
 *    message    : human-readable text. The only part the user ever sees.
 *    data       : optional structured payload (research findings, a plan
 *                 object, an executor's action results). Internal/for other
 *                 agents. Opaque on purpose.
 *    stateDelta : optional changes to persist into Context.state (e.g. the
 *                 planner updating progress). Merged into state after the turn.
 *    status     : did this agent succeed, partially succeed, or fail.
 *    diagnostics: optional non-fatal notes (warnings, what was skipped).
 *
 *  An agent that only wants to answer text just sets `message` + `status`.
 *  Everything else is optional, so simple agents stay simple while complex
 *  ones (executor, planner) have room to grow — without a contract change.
 * ------------------------------------------------------------------------- */
export type AgentStatus = "ok" | "partial" | "error";

export interface AgentResponse {
    contractVersion: typeof CONTRACT_VERSION;
    /** Which agent produced this. Filled by the agent itself. */
    from: AgentName;
    status: AgentStatus;
    /** Human-readable. The user-facing surface. Always present. */
    message: string;
    /** Optional structured payload for other agents / internal use. */
    data?: unknown;
    /** Optional state changes to merge into Context.state after the turn. */
    stateDelta?: Record<string, unknown>;
    /** Optional non-fatal notes. */
    diagnostics?: string[];
}

/* ----------------------------------------------------------------------------
 *  THE AGENT INTERFACE — the socket itself.
 *
 *  Researcher, Planner, Executor, the future Vision agent, AND the
 *  Orchestrator all implement this one interface. The orchestrator doesn't
 *  know what's inside any of them — it only knows: hand it a request, get a
 *  response. That uniformity is the whole game.
 * ------------------------------------------------------------------------- */
export interface Agent {
    readonly name: AgentName;
    handle(req: AgentRequest, ctx: Context): Promise<AgentResponse>;
}   