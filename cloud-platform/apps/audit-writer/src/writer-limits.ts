/**
 * U257: the writer's admission bounds, in one module so the API-side event
 * budget and the writer's body budget can be asserted against each other.
 */

/** Largest legal batch; also the `BATCH_INVALID` bound. */
export const MAX_BATCH = 1000

/**
 * U252: one event can carry 4096 B of metadata (~4.4 KiB serialized); the API
 * caps a legal event at 12 KiB, so 16 KiB admits every legal shape.
 */
export const MAX_EVENT_BYTES = 16 * 1024

/** Whole-body drain threshold: MAX_BATCH x MAX_EVENT_BYTES = 16 MiB. */
export const APPEND_BODY_MAX_BYTES = MAX_BATCH * MAX_EVENT_BYTES
