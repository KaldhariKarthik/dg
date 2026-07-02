/**
 * src/core/registry.ts
 *
 * The registry is just a phone book: name -> agent instance.
 *
 * Why it exists: the orchestrator must NOT import researcher/planner/executor
 * directly, or it becomes coupled to them. Instead it asks the registry "give
 * me the agent called X". Adding an agent = register one line here.
 *
 * It also resolves TURN CLAIMS (see types.ts): which agent, if any, holds an
 * open multi-message interaction that a follow-up should return to. This is how
 * the router routes follow-ups WITHOUT reading any agent's private state.
 */

import { Agent, AgentName, AgentInput, Context, TurnClaimant } from "./types";

/** Duck-type check: does this agent opt into claiming turns? */
function isClaimant(agent: Agent): agent is Agent & TurnClaimant {
    return typeof (agent as Partial<TurnClaimant>).claimsTurn === "function";
}

export class AgentRegistry {
    private agents = new Map<AgentName, Agent>();

    /** Register an agent under its own name. Throws on accidental duplicates. */
    register(agent: Agent): void {
        if (this.agents.has(agent.name)) {
            throw new Error(`Agent already registered: ${agent.name}`);
        }
        this.agents.set(agent.name, agent);
    }

    /** Look up an agent by name. Throws if the orchestrator routes to an agent
     *  that was never registered — a loud, early failure, by design. */
    get(name: AgentName): Agent {
        const agent = this.agents.get(name);
        if (!agent) {
            throw new Error(`No agent registered for: ${name}`);
        }
        return agent;
    }

    /** Which agents exist. The orchestrator uses this to know its options. */
    available(): AgentName[] {
        return [...this.agents.keys()];
    }

    /**
     * Ask each claimant agent whether it holds this turn, in registration order;
     * return the first that does, else null. Each agent inspects only its OWN
     * state, so the router stays ignorant of agent internals — it acts on the
     * agent NAME this returns, nothing more.
     */
    async resolveClaim(input: AgentInput, ctx: Context): Promise<AgentName | null> {
        for (const agent of this.agents.values()) {
            if (isClaimant(agent) && (await agent.claimsTurn(input, ctx))) {
                return agent.name;
            }
        }
        return null;
    }
}