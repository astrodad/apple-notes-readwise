export const baseURL = "https://readwise.io";
// DEBUG ONLY
// export const baseURL = "https://local.readwise.io:8000";

/**
 * Name of the Apple Shortcut that creates or appends markdown notes.
 * It receives JSON on stdin: {"key": string, "folder": string, "markdown": string}.
 * It finds a note whose body contains `key` and appends `markdown` to it, otherwise it
 * creates a note from `markdown` in `folder`. The app puts the "readwise-id: <key>" line
 * in the markdown itself, so the shortcut must not add one.
 */
export const IMPORT_SHORTCUT_NAME = 'Import Markdown to Notes';
