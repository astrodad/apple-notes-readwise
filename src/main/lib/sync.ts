import * as zip from '@zip.js/zip.js'
import Store from 'electron-store'
import { BrowserWindow } from 'electron'
import {
  ExportRequestResponse,
  ExportStatusResponse,
  ReadwiseAuthResponse,
  ReadwisePluginSettings,
  ReadwiseSyncMessage
} from '../../shared/types'
import {
  checkFolderExistsAndIsEmptyInAppleNotes,
  checkNotesAutomationAccess,
  checkFolderExistsInAppleNotes,
  createFolderInAppleNotes,
  getNoteKeysInFolder,
  importShortcutExists,
  noteKeyForBook,
  noteWithKeyExists,
  runImportShortcut
} from './utils'
import { baseURL, IMPORT_SHORTCUT_NAME } from '../../shared/constants'
import { store } from '@/lib/store'

// The shortcut runs one at a time: concurrent runs can race on the same Notes folder
const SHORTCUT_CONCURRENCY = 1

/** Inserts a "readwise-id: <key>" line after the first line (the title) of the markdown. */
function insertKeyAfterTitle(markdown: string, key: string): string {
  const keyLine = `readwise-id: ${key}`
  const newline = markdown.indexOf('\n')
  if (newline === -1) return `${markdown}\n\n${keyLine}\n`
  return `${markdown.slice(0, newline)}\n\n${keyLine}\n${markdown.slice(newline)}`
}

/**
 * Notes' markdown import turns ![](url) into an empty link instead of an image, so pull the
 * first image (the book/article cover) out of the markdown to attach it separately.
 */
function extractCoverImage(markdown: string): { markdown: string; imageUrl: string | null } {
  const match = markdown.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)
  if (!match) return { markdown, imageUrl: null }
  return { markdown: markdown.replace(match[0], ''), imageUrl: match[1] }
}

export function getAppleNoteClientID(): string {
  let appleNotesClientId = store.get('rw-AppleNotesClientId')
  if (appleNotesClientId) {
    return appleNotesClientId
  } else {
    appleNotesClientId = Math.random().toString(36).substring(2, 15)
    store.set('rw-AppleNotesClientId', appleNotesClientId)
    return appleNotesClientId
  }
}

export async function getUserAuthToken(uuid: string, attempt = 0): Promise<string> {
  let response: Response | undefined
  let data: ReadwiseAuthResponse | undefined
  try {
    response = await fetch(`${baseURL}/api/auth?token=${uuid}`)
  } catch (e) {
    console.log('MAIN: fetch failed in getUserAuthToken: ', e)
    return ''
  }
  if (response && response.ok) {
    data = await response.json()
  } else {
    console.log('MAIN: bad response in getUserAuthToken: ', response)
    return ''
  }

  if (!data) {
    console.log('MAIN: no data in getUserAuthToken')
    return ''
  }

  if (data.userAccessToken) {
    console.log('MAIN: successfully authenticated with Readwise')
    return data.userAccessToken
  } else {
    if (attempt > 20) {
      console.log('MAIN: reached attempt limit in getUserAuthToken')
      return ''
    }
    console.log(`MAIN: didn't get token data, retrying (attempt ${attempt + 1})`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return await getUserAuthToken(uuid, attempt + 1)
  }
}

export class ReadwiseSync {
  mainWindow: BrowserWindow

  store: Store<ReadwisePluginSettings>

  bookIdsMap = {}

  booksToRefresh: Array<string> = []
  failedBooks: Array<string> = []

  constructor(mainWindow: BrowserWindow, store: Store<ReadwisePluginSettings>) {
    this.mainWindow = mainWindow
    this.store = store
  }

  getAuthHeaders() {
    return {
      AUTHORIZATION: `Token ${this.store.get('token')}`,
      'Client-ID': `${getAppleNoteClientID()}`
    }
  }

  sendToRenderer(channel: string, ...args: any[]) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args)
    }
  }

  async writeZipEntryToAppleNotes(entry: zip.Entry, notesFolder: string, account: string) {
    const originalFileName = entry.filename
    const originalName = originalFileName.split('/')[1].split('--')[0].split('(')[0].trim()
    const bookId = originalFileName.split('--')[1].split('.')[0].trim()
    console.log(`Original name: ${originalName}`)
    console.log(`Book ID: ${bookId}`)

    try {
      if (!entry.getData) {
        console.log('MAIN: entry has no data')
        if (bookId) this.failedBooks.push(bookId)
        return
      }

      const content = await entry.getData(new zip.TextWriter())
      const key = noteKeyForBook(bookId)

      // The shortcut appends if a note containing the key exists, otherwise it creates one.
      const existedBefore = await noteWithKeyExists(key, notesFolder, account)
      const { markdown: body, imageUrl } = extractCoverImage(content)

      console.log(
        `MAIN: ${existedBefore ? 'appending to' : 'creating'} note: ${originalName} - (${bookId})`
      )

      // One shortcut call per note. Never create a note and then ask the shortcut to find it
      // moments later: its Find Notes step uses a search index that lags behind new notes,
      // which makes it create a stray note instead of appending.
      if (existedBefore) {
        // Drop the top-level heading so the title isn't repeated.
        await runImportShortcut({
          key,
          folder: notesFolder,
          markdown: body.replace(/^# .*?\n\s*/s, '')
        })
      } else {
        // Put the key right under the title line so later appends land after it.
        // The shortcut does not add its own readwise-id line.
        const newline = body.indexOf('\n')
        const head = insertKeyAfterTitle(newline === -1 ? body : body.slice(0, newline), key)
        const rest = newline === -1 ? '' : body.slice(newline + 1)
        await runImportShortcut({
          key,
          folder: notesFolder,
          // Full note, so a shortcut that ignores the fields below still works (without a cover).
          markdown: insertKeyAfterTitle(body, key),
          // Optional, used by shortcuts that can add the cover image themselves:
          // create the note from `head`, attach `image`, then append `rest`.
          ...(imageUrl ? { image: imageUrl, head, rest } : {})
        })
      }

      // `shortcuts run` exits 0 even if the shortcut failed, so confirm a new note really exists
      if (!existedBefore && !(await noteWithKeyExists(key, notesFolder, account))) {
        console.log(`MAIN: failed to create note: ${originalName} - (${bookId})`)
        this.failedBooks.push(bookId)
        return
      }

      this.bookIdsMap[bookId] = key
      this.sendToRenderer('syncing-progress')
    } catch (e) {
      console.log('MAIN: error writing note: ', e)
      if (bookId) {
        this.failedBooks.push(bookId)
        return
      }
    }
    await this.removeBooksFromRefresh([bookId])
    await this.removeBookFromFailedBooks([bookId])
  }

  // https://github.com/readwiseio/obsidian-readwise/blob/56d903b8d1bc18a7816603c300c6b0afa1241d0e/src/main.ts#L285
  async downloadExport(exportID: number): Promise<void> {
    // download archive from this endpoint
    const artifactURL = `${baseURL}/api/download_artifact/${exportID}`
    // TODO: not sure when this applies... seems to stop all syncing.
    // https://github.com/readwiseio/obsidian-readwise/blob/56d903b8d1bc18a7816603c300c6b0afa1241d0e/src/main.ts#L288
    // const lastSavedStatusID = store.get("lastSavedStatusID");
    // if (exportID <= lastSavedStatusID) {
    //   console.log(
    //     `MAIN: Already saved data from export ${exportID}`
    //   );
    //   // Send message to the renderer that the sync is completed
    //   this.mainWindow.webContents.send("syncing-complete");
    //   this.sendToRenderer('syncing-complete')
    //   await this.handleSyncSuccess(ReadwiseSyncMessage.ALREADY_SAVED);
    //   return;
    // }

    let response: Response | undefined, blob: Blob | undefined
    try {
      response = await fetch(artifactURL, { headers: this.getAuthHeaders() })
    } catch (e) {
      console.log('MAIN: fetch failed in downloadExport: ', e)
    }
    if (response && response.ok) {
      blob = await response.blob()
    } else {
      console.log('MAIN: bad response in downloadExport: ', response)
      return
    }

    const zipReader = new zip.ZipReader(new zip.BlobReader(blob))
    const entries = await zipReader.getEntries()

    const notesFolder = this.store.get('readwiseDir')
    const account = this.store.get('currentAccount')

    if (!notesFolder) {
      console.log('MAIN: no folder selected')
      this.sendToRenderer('toast:show', {
        variant: 'destructive',
        message: 'No folder selected'
      })
      await this.handleSyncError(ReadwiseSyncMessage.FAILED)
      return
    }

    if (!account) {
      console.log('MAIN: no account selected')
      this.sendToRenderer('toast:show', {
        variant: 'destructive',
        message: 'No account selected'
      })
      await this.handleSyncError(ReadwiseSyncMessage.FAILED)
      return
    }

    this.bookIdsMap = this.store.get('booksIDsMap') || {}
    this.failedBooks = this.store.get('failedBooks') || []

    if (entries.length) {
      this.sendToRenderer('syncing-start', entries.length)
      console.log('MAIN: syncing', entries.length, 'entries')

      const concurrency = SHORTCUT_CONCURRENCY
      const running: Promise<void>[] = []

      for (const entry of entries) {
        const p = this.writeZipEntryToAppleNotes(entry, notesFolder, account)
        running.push(p)

        // when p finishes, remove it from the array
        p.then(() => {
          running.splice(running.indexOf(p), 1)
        })

        // if we already have the max running, wait for one to finish
        if (running.length >= concurrency) {
          await Promise.race(running)
        }
      }

      // wait for all to finish
      await Promise.all(running)
    }
    // Close the reader
    await zipReader.close()

    // Update the store with the latest bookIdsMap, failedBooks, booksToRefresh
    this.store.set('booksIDsMap', this.bookIdsMap)
    this.store.set('failedBooks', this.failedBooks)
    this.store.set('booksToRefresh', this.booksToRefresh)

    // Acknowledge that the sync is completed
    await this.acknowledgeSyncCompleted()
    await this.handleSyncSuccess(ReadwiseSyncMessage.SYNCED, exportID)

    // Send message to the renderer that the sync is completed
    this.sendToRenderer('syncing-complete')

    console.log('MAIN: Synced!', exportID)
    console.log('MAIN: completed sync')
  }

  async removeBooksFromRefresh(bookIds: Array<string>) {
    if (!bookIds.length) return

    console.log(`MAIN: removing books ids ${bookIds.join(', ')} from refresh list`)

    const deduplicatedBooksToRefresh = this.booksToRefresh.filter(
      (bookId: string) => !bookIds.includes(bookId)
    )
    this.booksToRefresh = deduplicatedBooksToRefresh
  }

  async removeBookFromFailedBooks(bookIds: Array<string>) {
    if (!bookIds.length) return

    console.log(`MAIN: removing books ids ${bookIds.join(', ')} from failed list`)
    const deduplicatedFailedBooks = this.failedBooks.filter(
      (bookId: string) => !bookIds.includes(bookId)
    )
    this.failedBooks = deduplicatedFailedBooks
  }

  async acknowledgeSyncCompleted() {
    let response
    try {
      response = await fetch(`${baseURL}/api/poll/apple-notes/sync_ack`, {
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        method: 'POST'
      })
    } catch (e) {
      console.log('MAIN: fetch failed in acknowledgeSyncCompleted: ', e)
    }
    if (response && response.ok) {
      return
    } else {
      console.log('MAIN: bad response in acknowledgeSyncCompleted: ', response)
      await this.handleSyncError(this.getErrorMessageFromResponse(response))
      return
    }
  }

  async getExportStatus(statusID: number, token: string, uuid: string): Promise<void> {
    try {
      const response = await fetch(
        // status of archive build from this endpoint
        `${baseURL}/api/get_export_status?exportStatusId=${statusID}`,
        {
          headers: {
            ...this.getAuthHeaders()
          }
        }
      )

      if (response && response.ok) {
        const data: ExportStatusResponse = await response.json()

        const WAITING_STATUSES = ['PENDING', 'RECEIVED', 'STARTED', 'RETRY']
        const SUCCESS_STATUSES = ['SUCCESS']

        if (WAITING_STATUSES.includes(data.taskStatus)) {
          if (data.booksExported) {
            console.log(`MAIN: Exporting Readwise data (${data.booksExported} / ${data.totalBooks}) ...`)
            this.sendToRenderer('export-progress', data)
          } else {
            console.log('MAIN: Building export...')
          }

          // wait 1 second
          await new Promise((resolve) => setTimeout(resolve, 1000))
          // then keep polling
          await this.getExportStatus(statusID, token, uuid)
        } else if (SUCCESS_STATUSES.includes(data.taskStatus)) {
          this.sendToRenderer('export-complete', true)
          console.log('Export completed')
          await this.downloadExport(statusID)
        } else {
          console.log('MAIN: unknown status in getExportStatus: ', data)
          this.sendToRenderer('export-error', 'Download Export failed')
          await this.handleSyncError(ReadwiseSyncMessage.FAILED)
          return
        }
      } else {
        console.log('MAIN: bad response in getExportStatus: ', response)
        this.sendToRenderer('export-error', 'Download Export failed')
        await this.handleSyncError(this.getErrorMessageFromResponse(response))
      }
    } catch (e) {
      console.log('MAIN: fetch failed in getExportStatus: ', e)
      this.sendToRenderer('export-error', 'Download Export failed')
      await this.handleSyncError(ReadwiseSyncMessage.FAILED)
    }
  }

  getErrorMessageFromResponse(response: Response) {
    if (response && response.status === 409) {
      return 'Sync in progress initiated by different client'
    }
    if (response && response.status === 417) {
      return 'Apple Notes export is locked. Wait for an hour.'
    }
    return `${response ? response.statusText : "Can't connect to server"}`
  }

  async handleSyncError(msg = 'Sync failed') {
    await this.clearSettingsAfterRun()
    this.store.set('lastSyncFailed', true)
    console.log('MAIN: ', msg)
  }

  async clearSettingsAfterRun() {
    this.store.set('isSyncing', false)
    this.store.set('currentSyncStatusID', 0)
  }

  async handleSyncSuccess(msg = ReadwiseSyncMessage.SYNCED, exportID: number | null = null): Promise<void> {
    await this.clearSettingsAfterRun()
    this.store.set('lastSyncFailed', false)
    if (exportID) {
      this.store.set('lastSavedStatusID', exportID)
    }
    console.log('MAIN: ', msg)
  }

  async queueExport(statusId?: number, auto?: boolean): Promise<void> {
    if (this.store.get('isSyncing')) {
      console.log('MAIN: Readwise sync already in progress')
      this.sendToRenderer('toast:show', {
        variant: 'default',
        message: ReadwiseSyncMessage.SYNC_ALREADY_IN_PROGRESS.toString()
      })
      return
    }

    console.log('MAIN: requesting archive...')
    this.store.set('isSyncing', true)

    const readwiseDir = this.store.get('readwiseDir')
    const account = this.store.get('currentAccount')

    console.log('Readwise app: syncing to folder and account: ', { readwiseDir, account })

    if (!readwiseDir) {
      console.log('MAIN: no folder selected')
      this.sendToRenderer('toast:show', {
        variant: 'destructive',
        message: 'No folder selected'
      })
      await this.handleSyncError('Sync failed')
      return
    }

    if (!account) {
      console.log('MAIN: no account selected')
      this.sendToRenderer('toast:show', {
        variant: 'destructive',
        message: 'No account selected'
      })
      await this.handleSyncError('Sync failed')
      return
    }

    const notesAccess = await checkNotesAutomationAccess()
    if (!notesAccess.ok) {
      const denied = /-1743|not authorized|not allowed/i.test(notesAccess.error || '')
      this.sendToRenderer('toast:show', {
        variant: 'destructive',
        message: denied
          ? 'Not allowed to control Notes. Enable it in System Settings > Privacy & Security > Automation.'
          : `Could not talk to Notes: ${notesAccess.error}`
      })
      await this.handleSyncError('Sync failed')
      return
    }

    if (!(await importShortcutExists())) {
      console.log(`MAIN: shortcut "${IMPORT_SHORTCUT_NAME}" not found`)
      this.sendToRenderer('toast:show', {
        variant: 'destructive',
        message: `Shortcut "${IMPORT_SHORTCUT_NAME}" not found. Install it in the Shortcuts app.`
      })
      await this.handleSyncError('Sync failed')
      return
    }

    let parentDeleted = false

    // We need to check for three scanarios:
    // 1.) If the folder exists and is empty, then set parentDeleted to true to initiate a full sync
    // 2.) If the folder does not exist, then create it and set parentDeleted to true to initiate a full sync
    // 3.) If the folder exists and is not empty, then set parentDeleted to false to only sync new highlights
    const folderExists = await checkFolderExistsInAppleNotes(readwiseDir, account)
    const folderIsEmpty = await checkFolderExistsAndIsEmptyInAppleNotes(readwiseDir, account)

    // if the folder does not exist, create it and set parentDeleted to true to initiate a full sync
    if (!folderExists) {
      console.log('MAIN: folder does not exist, creating it')
      parentDeleted = true
      const folderCreated = await createFolderInAppleNotes(readwiseDir, account)
      if (!folderCreated) {
        console.log('MAIN: failed to create folder')
        await this.handleSyncError('Sync failed')
        this.sendToRenderer('toast:show', {
          variant: 'destructive',
          message: 'Failed to create folder'
        })
        return
      } else {
        console.log('MAIN: folder created')
      }
    } else {
      // if the folder exists, set parentDeleted to folderIsEmpty value (true if empty, false if not)
      // A scenario where the folder exists but is empty is when the user has deleted all notes in the folder
      // this should trigger a full sync just like when the folder does not exist
      parentDeleted = folderIsEmpty
    }

    let url = `${baseURL}/api/poll/apple-notes/init?parentPageDeleted=${parentDeleted}`
    if (statusId) {
      url += `&statusId=${statusId}`
    }
    if (auto) {
      url += `&auto=${auto}`
    }
    console.log('MAIN: queueExport url: ', url)

    let response: Response | undefined
    let data: ExportRequestResponse | undefined

    const token = this.store.get('token')
    const uuid = getAppleNoteClientID()

    try {
      response = await fetch(url, {
        headers: {
          ...this.getAuthHeaders()
        }
      })
    } catch (e) {
      console.log('MAIN: fetch failed in queueExport: ', e)
      return
    }

    if (response && response.ok) {
      data = await response.json()

      // check if data is defined
      if (!data) {
        console.log('MAIN: no data in queueExport')
        await this.handleSyncError('Sync failed')
        this.sendToRenderer('toast:show', {
          variant: 'destructive',
          message: ReadwiseSyncMessage.FAILED.toString()
        })
        return
      }

      const lastest_id = this.store.get('lastSavedStatusID')
      console.log(data.latest_id)
      if (data.latest_id <= lastest_id) {
        await this.handleSyncSuccess() // Data is already up to date
        console.log('MAIN: Readwise data is already up to date')
        this.sendToRenderer('toast:show', {
          variant: 'default',
          message: ReadwiseSyncMessage.ALREADY_SAVED.toString()
        })
        return
      }

      this.store.set('lastSavedStatusID', data.latest_id)
      console.log('MAIN: saved currentSyncStatusID: ', data.latest_id)

      // save the sync status id so it can be polled until the archive is ready
      if (response.status === 201) {
        console.log('MAIN: Syncing Readwise data')
        await this.getExportStatus(data.latest_id, token, uuid)
        console.log('MAIN: queueExport done')
        this.sendToRenderer('toast:show', {
          variant: 'success',
          message: ReadwiseSyncMessage.SYNCED.toString()
        })
        return
      } else {
        await this.handleSyncSuccess(ReadwiseSyncMessage.SYNCED, data.latest_id)
        console.log(
          'Latest Readwise sync already happended on your other device. Data should be up to date: ',
          response
        )
        this.sendToRenderer('toast:show', {
          variant: 'success',
          message: ReadwiseSyncMessage.SAVED_ON_ANOTHER_DEVICE.toString()
        })
        return
      }
    } else {
      console.log('MAIN: bad response in queueExport: ', response)
      await this.handleSyncError(this.getErrorMessageFromResponse(response))
      return
    }
  }

  /**
   * Books we synced before whose note has since been deleted. Their next export would only
   * contain new highlights, so we ask Readwise to re-export them in full.
   * Skips if the folder is empty/unreadable: queueExport already does a full sync then.
   */
  async findBooksWithMissingNotes(): Promise<string[]> {
    const folder = this.store.get('readwiseDir')
    const account = this.store.get('currentAccount')
    if (!folder || !account) return []

    const map = this.store.get('booksIDsMap') || {}
    // only entries written by the shortcut flow (older entries hold AppleScript note ids)
    const syncedBookIds = Object.entries(map)
      .filter(([, value]) => typeof value === 'string' && value.startsWith('rwid-'))
      .map(([bookId]) => bookId)
    if (!syncedBookIds.length) return []

    try {
      const existingKeys = await getNoteKeysInFolder(folder, account)
      if (!existingKeys || existingKeys.size === 0) return []
      return syncedBookIds.filter((bookId) => !existingKeys.has(noteKeyForBook(bookId)))
    } catch (e) {
      console.log('MAIN: failed to look for missing notes: ', e)
      return []
    }
  }

  // https://github.com/readwiseio/obsidian-readwise/blob/56d903b8d1bc18a7816603c300c6b0afa1241d0e/src/main.ts#L436
  async syncHighlights(bookIds?: Array<string>, auto = false): Promise<void> {
    if (!this.store.get('token')) return

    const failedBooks = this.store.get('failedBooks')

    const missingBooks = await this.findBooksWithMissingNotes()
    if (missingBooks.length) {
      console.log('MAIN: notes missing for books, requesting full re-export: ', missingBooks)
    }

    let targetBookIds = Array.from(new Set([...(bookIds || []), ...failedBooks, ...missingBooks]))

    console.log('MAIN: syncing highlights for books: ', targetBookIds)

    const booksToRefresh = this.store.get('booksToRefresh')
    const refreshBooks = this.store.get('refreshBooks')

    if (refreshBooks) {
      targetBookIds = [...targetBookIds, ...booksToRefresh]
    }

    if (!targetBookIds.length) {
      console.log('MAIN: no targetBookIds, checking for new highlights')
      await this.queueExport()
      return
    }

    console.log('MAIN: refreshing books: ', {
      targetBookIds
    })

    try {
      const response = await fetch(
        // add books to next archive build from this endpoint
        // NOTE: should only end up calling this endpoint when:
        // 1. there are failedBooks
        // 2. there are booksToRefresh
        `${baseURL}/api/refresh_book_export`,
        {
          headers: {
            ...this.getAuthHeaders(),
            'Content-Type': 'application/json'
          },
          method: 'POST',
          body: JSON.stringify({
            exportTarget: 'apple-notes',
            books: targetBookIds
          })
        }
      )

      if (response && response.ok) {
        await this.queueExport()
        return
      } else {
        console.log(`MAIN: saving book id ${bookIds} to refresh later`)
        const booksToRefresh = store.get('booksToRefresh')
        const deduplicatedBookIds = new Set([...booksToRefresh, ...targetBookIds])
        this.store.set('booksToRefresh', Array.from(deduplicatedBookIds))
        return 
      }
    } catch (e) {
      console.log('MAIN: fetch failed in syncBookHighlights: ', e)
      return
    }
  }
}
