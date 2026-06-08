"use strict";
/**
 * src/auth/stores.ts — the IDENTITY persistence seams.
 *
 * Twin of src/store/store.ts, but for identity instead of working state. The
 * auth layer depends on THESE interfaces, never on Firestore or the filesystem.
 * Firestore (prod) and File (dev) implementors live in src/store/*Stores.ts and
 * are chosen by one wiring line in the factory.
 *
 * Why separate from the working-state `Store`: different lifecycle and access
 * pattern. User/session records are read on every authenticated request and
 * must be safe under concurrency; the working-state bag is the planner/vision
 * scratch space. Conflating them is how you end up loading the whole user blob
 * on every vision frame.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=stores.js.map