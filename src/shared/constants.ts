export const baseURL = "https://readwise.io";
// DEBUG ONLY
// export const baseURL = "https://local.readwise.io:8000";

/**
 * Name of the Apple Shortcut that creates or appends markdown notes.
 * It receives JSON on stdin:
 *   {"key", "folder", "markdown"} and, for notes with a cover, also {"image", "head", "rest"}.
 * It finds a note whose body contains `key` and appends `markdown` to it. Otherwise it creates
 * a note in `folder`: from `markdown`, or, if `image` is set, from `head`, then attaches the
 * image and appends `rest`. The app puts the "readwise-id: <key>" line in the markdown itself,
 * so the shortcut must not add one.
 */
export const IMPORT_SHORTCUT_NAME = 'Import Markdown to Notes with Images';
