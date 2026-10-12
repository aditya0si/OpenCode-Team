/**
 * Host-safe plugin entry (adapter).
 *
 * The installed OpenCode 1.18.13 plugin loader enumerates every export of a
 * plugin module and requires each to be a function. `src/index.ts` also
 * exports `id` (string) and `DEFAULT_POLICY` (object) for library consumers,
 * so the host rejects it with "Plugin export is not a function". This adapter
 * re-exports only the default factory, which the host loads cleanly.
 *
 * Library consumers keep the full named surface from `./index.js`.
 */

import { TeamPlugin } from "./index.js";

export default TeamPlugin;
