export const CONTRACT_VERSION = "1.2" as const;

export type AgentName =
    | "orchestrator"
    | "researcher"
    | "planner"
    | "executor"
    | "conversational"
    | "vision";

export interface TextInput {
    kind: "text";
    text: string;
}

export interface SceneInput {
    kind: "scene";
    scene: unknown;
    text?: string;
}

export type AgentInput = TextInput | SceneInput;

export interface MemoryData {
    preferences: Record<string, string>;
    past_patterns: string[];
    long_term_facts: string[];
}

export interface Context {
    userId: string;
    state: Record<string, unknown>;
    history: Turn[];
    memory?: MemoryData;
    startedAt: string;
}

export interface Turn {
    role: "user" | AgentName;
    message: string;
    at: string;
}

export interface AgentRequest {
    contractVersion: typeof CONTRACT_VERSION;
    input: AgentInput;
}

export type AgentStatus = "ok" | "partial" | "error";

export interface AgentResponse {
    contractVersion: typeof CONTRACT_VERSION;
    from: AgentName;
    status: AgentStatus;
    message: string;
    data?: unknown;
    stateDelta?: Record<string, unknown>;
    diagnostics?: string[];
}

export interface Agent {
    readonly name: AgentName;
    handle(req: AgentRequest, ctx: Context): Promise<AgentResponse>;
}

export interface TurnClaimant {
    claimsTurn(input: AgentInput, ctx: Context): boolean | Promise<boolean>;
}

/* ----------------------------------------------------------------------------
 *  VISION PERCEPTION SCHEMA (v1.0) — the single source of truth.
 *
 *  The perception edge (the browser client + the /api/vision model) emits a
 *  structured observation; the vision agent consumes it and returns a directive.
 *  These shapes used to be written down in four places (the model's system
 *  prompt, the /api/vision response literal, the browser client, and the vision
 *  agent) — exactly how schemas drift. They live HERE now so the client
 *  (compiled by esbuild) and the server import ONE definition.
 *
 *  ADDITIVE: SceneInput.scene stays `unknown` at the agent boundary (we can't
 *  force a model's output to be typed), so the agent CONTRACT is unchanged and
 *  CONTRACT_VERSION stays 1.2. These types describe the vision envelope, which
 *  carries its own `schema_version` ("1.0").
 * ------------------------------------------------------------------------- */

export const VISION_SCHEMA_VERSION = "1.0" as const;

export interface SceneObject {
    id: string;
    label: string;
    state: string;
    position: string | null;
    confidence: number;
}

export interface SceneAnomaly {
    type: "warning" | "info" | "danger";
    description: string;
}

export interface SpatialLayout {
    description: string;
    dimensions_available: boolean;
}

export interface VisionScene {
    summary: string;
    environment: string;
    objects: SceneObject[];
    spatial_layout: SpatialLayout;
    anomalies: SceneAnomaly[];
}

export interface VisionTaskContext {
    task: string;
    mode: string;
}

export interface VisionMediaMeta {
    source_type: string;
    frame_index: number | null;
    resolution: string | null;
    capture_device: string;
}

/** The full v1.0 observation envelope returned by POST /api/vision. */
export interface VisionObservation {
    schema_version: typeof VISION_SCHEMA_VERSION;
    input_type: "visual";
    session_id: string;
    timestamp: string;
    task_context: VisionTaskContext;
    scene: VisionScene;
    user_flags: {
        explicitly_mentioned: string[];
        user_transcript: string;
    };
    media_meta: VisionMediaMeta;
    /** Which model produced this; informational. */
    model?: string;
}

/**
 * The down-direction contract (orchestrator -> perception), returned by
 * POST /api/orchestrate and applied by the client. `watch_for` carries an
 * active condition (null clears it); `done` closes a watched condition.
 */
export interface VisionDirective {
    guidance: string;
    watch_for: string | null;
    done: boolean;
    done_message: string;
    /** Rare: the orchestrator may nudge task/mode. */
    task_context?: Partial<VisionTaskContext>;
    /** 6B: index of a plan step the server just checked off this turn (guided). */
    step_checked?: number | null;
}