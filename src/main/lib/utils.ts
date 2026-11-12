import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { store } from '@/lib/store'
import { IMPORT_SHORTCUT_NAME } from '../../shared/constants'

// https://github.com/sindresorhus/run-applescript/blob/9db60e8a8fa7db46534c3c8a05c0f58135280ebb/index.js#L5
async function runAppleScript(
  script: string,
  { humanReadableOutput = true } = {}
): Promise<string> {
  const outputArguments = humanReadableOutput ? [] : ['-ss']

  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...outputArguments], { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Error: ${stderr || error.message}`))
      } else {
        resolve(stdout.trim())
      }
    })
  })
}

/**
 * Verifies this app is allowed to control Notes. Without Automation permission every
 * folder/note script fails, and the scripts below swallow errors, so a denied permission
 * would otherwise look like "folder doesn't exist".
 */
export async function checkNotesAutomationAccess(): Promise<{ ok: boolean; error?: string }> {
  try {
    await runAppleScript('tell application "Notes" to return name of default account')
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.log('MAIN: cannot control Notes: ', message)
    return { ok: false, error: message }
  }
}

/**
 * Unique, delimited key stored in each note. The "-end" suffix prevents a key
 * from being a substring of another (e.g. book 12 vs book 123) since the
 * shortcut finds notes with "body contains key".
 */
export function noteKeyForBook(bookId: string): string {
  return `rwid-${bookId}-end`
}

export async function importShortcutExists(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('shortcuts', ['list'], (error, stdout) => {
      if (error) return resolve(false)
      const names = stdout.split('\n').map((s) => s.trim())
      resolve(names.includes(IMPORT_SHORTCUT_NAME))
    })
  })
}

/**
 * Runs the import shortcut with the payload as JSON on stdin.
 * NOTE: `shortcuts run` exits 0 even when a step fails, so callers must verify
 * the result (see noteWithKeyExists).
 */
export function runImportShortcut(payload: {
  key: string
  folder: string
  markdown: string
  /** cover image URL; the shortcut attaches it (Notes' markdown import drops images) */
  image?: string
  /** the note's title + key, to create first when `image` is set */
  head?: string
  /** everything after the title, to append after the image when `image` is set */
  rest?: string
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'shortcuts',
      ['run', IMPORT_SHORTCUT_NAME],
      { timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`shortcuts run failed: ${stderr || error.message}`))
        else resolve()
      }
    )
    child.stdin?.end(JSON.stringify(payload))
  })
}

export async function noteWithKeyExists(
  key: string,
  folder: string,
  account: string
): Promise<boolean> {
  const script = `
    tell application "Notes"
      try
        set targetFolder to folder "${escapeAppleScriptString(folder)}" of account "${escapeAppleScriptString(account)}"
        return (count of (notes of targetFolder whose body contains "readwise-id: ${escapeAppleScriptString(key)}")) > 0
      on error
        return false
      end try
    end tell
  `
  const result = await executeAppleScript(script)
  return result === 'true'
}

/**
 * Returns the set of readwise-id keys found in the notes of a folder, or null if the
 * folder could not be read. Reads all note text in a single AppleScript call.
 */
export async function getNoteKeysInFolder(
  folder: string,
  account: string
): Promise<Set<string> | null> {
  const script = `
    tell application "Notes"
      try
        set targetFolder to folder "${escapeAppleScriptString(folder)}" of account "${escapeAppleScriptString(account)}"
        set noteTexts to plaintext of every note of targetFolder
        set AppleScript's text item delimiters to linefeed
        return noteTexts as text
      on error
        return "__ERROR__"
      end try
    end tell
  `
  const result = await executeAppleScript(script)
  if (result === '__ERROR__') return null
  const keys = new Set<string>()
  for (const match of result.matchAll(/readwise-id: (rwid-\S+?-end)/g)) {
    keys.add(match[1])
  }
  return keys
}

export async function updateAppleNotesAccounts() {
  const newAccounts = await getAppleNotesAccounts()
  const storedAccounts = store.get('accounts') || []
  const storedDefaultAccount = store.get('defaultAccount') || ''

  // Check if there are any new accounts
  if (JSON.stringify(newAccounts) !== JSON.stringify(storedAccounts)) {
    store.set('accounts', newAccounts)
  }

  if (!storedDefaultAccount) {
    const defaultAccount = await fetchDefaultAccount()
    store.set('defaultAccount', defaultAccount)
    store.set('currentAccount', defaultAccount)
  }

  return {
    accounts: store.get('accounts'),
    defaultAccount: store.get('defaultAccount'),
    currentAccount: store.get('currentAccount')
  }
}

function escapeAppleScriptString(text: string | number | null | undefined) {
  if (!text && text !== 0) return '' // Handle undefined, null, or empty cases
  return text
    .toString()
    .replace(/\\/g, '\\\\') // Escape backslashes
    .replace(/"/g, '\\"') // Escape double quotes
    .replace(/\n/g, '\\n') // Escape newlines
}

const executeAppleScript = async (script: string): Promise<string> => {
  try {
    const result = await runAppleScript(script)
    return result
  } catch (error) {
    console.error('Error executing AppleScript:', error)
    throw error
  }
}

async function fetchDefaultAccount() {
  const script = `
    tell application "Notes"
      set defaultAccount to the default account
      set defaultAccountName to name of defaultAccount
      return defaultAccountName
    end tell
  `
  const result = await executeAppleScript(script)
  return result.trim()
}

export async function getAppleNotesAccounts(): Promise<string[]> {
  const script = `
    tell application "Notes"
      set accountNames to {}
      
      -- Loop through each account and collect names
      repeat with anAccount in accounts
          set end of accountNames to name of anAccount
      end repeat
      
      -- Return the list of account names
      return accountNames
    end tell
    `

  const result = await executeAppleScript(script)
  return result.split(', ')
}

export const checkFolderExistsAndIsEmptyInAppleNotes = async (
  folder: string,
  account: string
): Promise<boolean> => {
  const script = `
    tell application "Notes"
      set folderName to "${folder}"
      set accountName to "${account}"
      
      try
          set targetFolder to folder folderName of account accountName
          if (count of notes of targetFolder) is 0 then
              return true -- Folder exists and is empty
          else
              return false -- Folder exists but is not empty
          end if
      on error
          return false -- Folder does not exist
      end try
    end tell
  `

  const result = await executeAppleScript(script)
  return result === 'true'
}

export const checkFolderExistsInAppleNotes = async (
  folder: string,
  account: string
): Promise<boolean> => {
  const script = `
      tell application "Notes"
        set folderName to "${folder}"
        set accountName to "${account}"
        
        try
            set targetFolder to folder folderName of account accountName
            return true -- Folder exists
        on error
            return false -- Folder does not exist
        end try
      end tell
    `

  const result = await executeAppleScript(script)
  return result === 'true'
}

export const createFolderInAppleNotes = async (
  folder: string,
  account: string
): Promise<boolean> => {
  const script = `
      tell application "Notes"
        set folderName to "${folder}"
        set accountName to "${account}"
        
        try
            set targetAccount to account accountName
            make new folder at targetAccount with properties {name:folderName}
            return true -- Folder created
        on error
            return false -- Folder not created
        end try
      end tell
    `

  const result = await executeAppleScript(script)
  return result === 'true'
}

/**
 * Cover images are downloaded by the app and handed to the shortcut as http://127.0.0.1 URLs.
 * If the shortcut fetched the original URLs itself, macOS would ask for permission once per
 * website. With a local server there is a single host to approve.
 */
const localImages = new Map<string, { data: Buffer; type: string }>()
let localImageServer: Promise<number> | null = null
let localImageCounter = 0

function startLocalImageServer(): Promise<number> {
  if (!localImageServer) {
    localImageServer = new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const image = localImages.get((req.url || '').split('?')[0])
        if (!image) {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, { 'Content-Type': image.type, 'Content-Length': image.data.length })
        res.end(image.data)
      })
      server.on('error', (e) => {
        localImageServer = null
        reject(e)
      })
      // 127.0.0.1 only, so nothing outside this machine can reach it
      server.listen(0, '127.0.0.1', () => {
        server.unref()
        resolve((server.address() as AddressInfo).port)
      })
    })
  }
  return localImageServer
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/svg+xml': 'svg'
}

/**
 * Downloads an image and returns a local URL serving it, or null if it can't be fetched
 * (the note is then created without a cover). Call releaseLocalImage when done.
 */
export async function serveImageLocally(imageUrl: string): Promise<string | null> {
  try {
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return null
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const ext = IMAGE_EXTENSIONS[type]
    if (!ext) return null // not an image (e.g. an HTML error page)
    const data = Buffer.from(await response.arrayBuffer())
    const path = `/${++localImageCounter}.${ext}`
    localImages.set(path, { data, type })
    const port = await startLocalImageServer()
    return `http://127.0.0.1:${port}${path}`
  } catch (e) {
    console.log('MAIN: could not download cover image: ', imageUrl, e)
    return null
  }
}

export function releaseLocalImage(localUrl: string) {
  localImages.delete(new URL(localUrl).pathname)
}
