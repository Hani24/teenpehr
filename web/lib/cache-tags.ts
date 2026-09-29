/**
 * Cache tags for the published data cached across requests (lib/queries.ts). EDITIONS_TAG: editions,
 * stories, groups, sources, the glossary and the Editor's desk; SETTINGS_TAG: the settings table. Here, not
 * in lib/queries.ts, so modules that only expire them (worker routes, lib/jobs.ts) need not load the reader queries.
 */
export const EDITIONS_TAG = "editions";
export const SETTINGS_TAG = "settings";
