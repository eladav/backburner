import { createActor } from "xstate";
import type { WorkstreamPhase } from "../../state/types.js";
import { deriveWorkstreamMachineEvents } from "./derive-events.js";
import { workstreamMachine } from "./machine.js";
import type { WorkstreamMachineContext } from "./types.js";

export function evaluateWorkstreamMachine(input: WorkstreamMachineContext): WorkstreamPhase {
  const events = deriveWorkstreamMachineEvents(input);
  const initialSnapshot = input.previousPhase === undefined
    ? undefined
    : workstreamMachine.resolveState({
        value: input.previousPhase,
        context: input
      });
  const actor = createActor(workstreamMachine, initialSnapshot === undefined
    ? { input }
    : {
        input,
        snapshot: initialSnapshot
      }).start();

  for (const event of events) {
    actor.send(event);
  }

  const phase = actor.getSnapshot().value;
  actor.stop();

  return phase as WorkstreamPhase;
}
