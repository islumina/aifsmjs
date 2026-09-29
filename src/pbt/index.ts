export {
  commandsFromMachine,
  initialModel,
  type EventArbitraries,
  type FsmCommand,
  type FsmModel,
} from "./commands.js";

export {
  assertAll,
  assignDoesNotMutate,
  guardsFalseNoTransition,
  reachableStatesSubsetDeclared,
  replayEqualsFold,
  snapshotAlwaysFrozen,
  unknownEventNoOp,
  type AssertOpts,
} from "./properties.js";

// Convenience namespace mirroring the README:
//   import { properties } from "aifsmjs/pbt"
//   properties.snapshotAlwaysFrozen(...)
// A frozen object literal rather than `import * as`: a namespace re-export
// makes tsup emit a shared `__export` helper chunk that every subpath entry
// (root, guards, timer, ...) then imports and pays for.
import {
  assertAll,
  assignDoesNotMutate,
  contextEquals,
  guardsFalseNoTransition,
  reachableStatesSubsetDeclared,
  replayEqualsFold,
  snapshotAlwaysFrozen,
  unknownEventNoOp,
} from "./properties.js";
export const properties = Object.freeze({
  assertAll,
  assignDoesNotMutate,
  contextEquals,
  guardsFalseNoTransition,
  reachableStatesSubsetDeclared,
  replayEqualsFold,
  snapshotAlwaysFrozen,
  unknownEventNoOp,
});
