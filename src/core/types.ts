/**
 * ============================================================================
 *  core/types.ts  —  THE CONTRACT ("the socket")
 * ============================================================================
 *
 *  This file is the single most important file in the project.
 *
 *  Everything else (orchestrator, researcher, planner, executor, vision agent,
 *  the model provider, the adapters) is REPLACEABLE. This file is not.
 *
 *  The rule:
 *    - Editing an agent's internal logic        -> fine, do it daily.
 *    - Editing the shapes in THIS file          -> rare, deliberate, versioned.
 *
 *  CONTRACT_VERSION 1.1 (multi-user): Context.sessionId -> Context.userId.
 *  CONTRACT_VERSION 1.2 (memory): added MemoryData + optional Context.memory,
 *  the per-user profile the orchestrator loads each turn so agents can READ
 *  what's been learned about the user (additive; existing agents unaffected).
 * ============================================================================
 */

export const CONTRACT_VERSION = "1.2" as const;

/* ----------------------------------------------------------------------------
 *  WHO can be an agent.
 * ------------------------------------------------------------------------- */
export type AgentName =
    | "orchestrator"
    | "researcher"
    | "planner"
    | "executor"
    | "conversational"
    | "vision";

/* ----------------------------------------------------------------------------
 *  INPUT — what the user/orchestrator hands to an agent.
 * ------------------------------------------------------------------------- */
export interface TextInput {
    kind: "text";
    text: string;
}

export interface SceneInput {
    kind: "scene";
    /**
     * The vision pipeline's structured scene object. Kept as `unknown`
     * deliberately: the contract does not freeze the scene's internal shape.
     */
    scene: unknown;
    /** Optional accompanying utterance, if the user also spoke/typed. */
    text?: string;
}

export type AgentInput = TextInput | SceneInput;

/* ----------------------------------------------------------------------------
 *  MEMORY — the per-user long-term profile.
 *
 *  Lives in the contract because it crosses module boundaries: the MemoryStore
 *  persists it, the orchestrator loads it onto Context each turn, and agents
 *  read it. It is CONTEXT, not command — an agent weighs it when relevant and
 *  never lets a remembered fact override an explicit current request.
 * ------------------------------------------------------------------------- */
export interface MemoryData {
    /** key -> value, e.g. { "trip_style": "short and low-effort" }. */
    preferences: Record<string, string>;
    /** recurring habits, e.g. "tends to trim plans down when they feel heavy". */
    past_patterns: string[];
    /** durable facts, e.g. "lives in Hyderabad". */
    long_term_facts: string[];
}

/* ----------------------------------------------------------------------------
 *  CONTEXT — everything an agent needs that isn't the input itself.
 *
 *  `userId` is the authenticated user (Google sub). It ties a conversation
 *  together AND selects whose stored state, plans, memory, and Google tokens
 *  are used — so multi-user falls out everywhere from this one field. It is set
 *  by the server from the session cookie; agents can trust it.
 * ------------------------------------------------------------------------- */
export interface Context {
    /** Authenticated user id (Google sub). Server-resolved; never client-sent. */
    userId: string;
    /**
     * Persisted per-user working state. The planner writes progress here; the
     * vision agent writes its active watch_for here; any agent may read it.
     * Loaded from the Store before a request, saved after.
     */
    state: Record<string, unknown>;
    /** Prior turns, oldest first, that the orchestrator decided to surface. */
    history: Turn[];
    /**
     * The user's long-term memory profile, loaded by the orchestrator at the
     * start of a turn. Read-only for agents. Optional so a Context built without
     * it (or by older code) still type-checks.
     */
    memory?: MemoryData;
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
    contractVersion: typeof CONTRACT_VERSION;
    input: AgentInput;
}

/* ----------------------------------------------------------------------------
 *  RESPONSE — what every agent MUST hand back.
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
 * ------------------------------------------------------------------------- */
export interface Agent {
    readonly name: AgentName;
    handle(req: AgentRequest, ctx: Context): Promise<AgentResponse>;
}

/* ----------------------------------------------------------------------------
 *  TURN CLAIM — an optional capability, not part of the core Agent interface.
 *
 *  Some agents run multi-message interactions: the executor drafts an email and
 *  waits for "yes / no / change it"; a future booking agent confirms a
 *  reservation across turns. While such an interaction is open, the user's NEXT
 *  message belongs to THAT agent — not to fresh routing.
 *
 *  Rather than let the router snoop an agent's private state to detect this (the
 *  old leak: the router reading `state.emailDraft` etc.), an agent DECLARES it
 *  by implementing TurnClaimant. The router learns only THAT a claim exists, and
 *  whose — never what it's about. Agents with no cross-turn state (researcher,
 *  conversational) simply don't implement this and pay nothing.
 * ------------------------------------------------------------------------- */
export interface TurnClaimant {
    /**
     * Return true if this agent holds an open interaction for this user that a
     * follow-up message should be routed back to. MUST read only this agent's
     * OWN state via ctx — never another agent's keys.
     */
    claimsTurn(input: AgentInput, ctx: Context): boolean | Promise<boolean>;
}