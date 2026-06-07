/**
 * src/core/registry.ts
 *
 * The registry is just a phone book: name -> agent instance.
 *
 * Why it exists: the orchestrator must NOT import researcher/planner/executor
 * directly, or it becomes coupled to them (add a 5th agent -> edit the
 * orchestrator -> risk breaking the loop). Instead it asks the registry
 * "give me the agent called X". Adding the future vision agent = register one
 * line here. The orchestrator never changes.
 */

import { Agent, AgentName } from "./types";

export class AgentRegistry {
    private agents = new Map<AgentName, Agent>();

    /** Register an agent under its own name. Throws on accidental duplicates. */
    register(agent: Agent): void {
        if (this.agents.has(agent.name)) {
            throw new Error(`Agent already registered: ${agent.name}`);
        }
        this.agents.set(agent.name, agent);
    }

    /** Look up an agent by name. Throws if the orchestrator routes to an
     *  agent that was never registered — a loud, early failure, by design. */
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
}