export const baseURL = "https://readwise.io";
// DEBUG ONLY
// export const baseURL = "https://local.readwise.io:8000";

/**
 * Name of the Apple Shortcut that creates or appends markdown notes.
 * It receives JSON on stdin: {"key": string, "folder": string, "markdown": string},
 * finds a note whose body contains `key`, appends to it, or creates a note
 * (markdown + "readwise-id: <key>") in `folder`.
 */
export const IMPORT_SHORTCUT_NAME = 'Import Markdown to Notes';

export const NOTE_FOLDER_PATH = 'Library/Group Containers/group.com.apple.notes';
export const NOTE_DB = 'NoteStore.sqlite';
/** Additional amount of seconds that Apple CoreTime datatypes start at, to convert them into Unix timestamps. */
export const CORETIME_OFFSET = 978307200;