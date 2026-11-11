# Readwise 📚 to Apple Notes Export 📥

> [!WARNING]
> ⚠️ **Please note that this product is currently in early development, and you may encounter some issues during use or while syncing.** 
> 
> We are actively working towards a stable release and greatly appreciate your feedback. We welcome early beta testers to help us improve the app. 
> 
> If you experience any problems, please feel free to submit an issue. Pull requests are also welcome! 
> 
> Your contributions are invaluable as we work towards delivering a more reliable experience. Thank you for your support! ⚠️

This app enables you to easily export all your digital highlights to Apple Notes from a variety of sources such as Amazon Kindle, Apple Books, Google Play Books, Instapaper, Pocket, Medium, Twitter, PDFs, and more.

> [!NOTE]
> This app requires a subscription with [Readwise](https://readwise.io/) - a paid service that makes it easy to aggregate and review all your reading data into one place.

## Features

- **Customize Formatting** 💅: - use Readwise's formatting tool to change how the note appears in Apple Notes.
- **Multi-Account Support** 👥: Select from multiple Apple Notes accounts (e.g. iCloud, Gmail).
- **Folder Management** 📁: Automatically create and verify folders in Apple Notes.
- **Automatic Syncing** 🔄: Configure the frequency of when new highlights are added.

## Installation

1. Go to [https://readwise.io/apple_notes](https://readwise.io/apple_notes/start).

---

## Usage

1. **Launch the App:** Start the application after installation.
2. **Select Account:** Choose your Apple Notes account from the dropdown menu (e.g., iCloud, Gmail).
3. **Specify Folder:**
   - Enter the name of the folder where notes will be imported.
   - If the folder doesn’t exist, it will be created.
4. **Pick a sync frequency:**
   - Use the select box to pick a frequency your want your highlights to re-sync. (e.g. `Every 1 Hour`, `Every 12 Hours` etc.)
5. **Initiate Sync:** Click the 'Initiate Sync' button to start the sync process. You'll get messages on the progress of the current sync.
6. **Success Notification:** Once completed, you’ll receive a success message.

---

## Required Shortcut

Notes are created through an Apple Shortcut so they get native Apple Notes styling (Title, Heading, Body) instead of imported-HTML formatting. The app looks for a shortcut named **`Import Markdown to Notes`** and won't sync without it.

Create it in the Shortcuts app with these actions (your version of macOS must offer the **Interpret as Markdown** option on the Notes actions):

1. **Receive** Text/Files from Share Sheet/Nowhere (If there's no input: Continue).
2. **Get Dictionary from** Shortcut Input.
3. **Get Dictionary Value** for `key`, then **Set Variable** `noteKey`.
4. **Get Dictionary Value** for `folder`, then **Set Variable** `folderName`.
5. **Get Dictionary Value** for `markdown`, then **Set Variable** `markDown`.
6. **Find Notes** where **Body contains** `noteKey`, limit 1. Do not filter by folder (a text value can't be used as a Folder filter).
7. **If** the found Note **has any value**:
   - **Append** `markDown` to the Note, with **Interpret as Markdown** on.
8. **Otherwise**:
   - **Create Note** with `markDown` in the folder `folderName`, with **Interpret as Markdown** on and the **Name** left empty.
9. **End If**.

The app runs it with `shortcuts run "Import Markdown to Notes"` and passes JSON on stdin:

```json
{"key": "rwid-12345-end", "folder": "Readwise", "markdown": "# Title\n\nreadwise-id: rwid-12345-end\n\n..."}
```

The app writes the `readwise-id` line itself (under the note's title) and uses it to find the note again later, so the shortcut must not add its own copy. The key is delimited (`rwid-<id>-end`) so one book's key is never a substring of another's.

To check it works, run this in Terminal; a new note should appear in the folder:

```bash
echo '{"key":"rwid-0-end","folder":"Readwise","markdown":"# Test\n\nreadwise-id: rwid-0-end\n\nHello"}' | shortcuts run "Import Markdown to Notes"
```

> Note: `shortcuts run` exits with status 0 even when a step fails, so the app confirms new notes exist after creating them.

### How syncing works

- A book's note is found by its `readwise-id` line, not by the note's title or an AppleScript ID, so you can rename notes freely.
- New highlights are appended to the end of an existing note.
- If you delete a book's note, the next sync asks Readwise to re-export that book in full and recreates the note. Deleting every note in the folder triggers a full sync.
- Notes created by older versions of the app have no `readwise-id` line, so the next sync creates a new note for those books.

---

## Screenshots

![main-screen](/screenshots/app-and-apple-notes.png)

Track sync progress

![sync-highlights-progress](/screenshots/sync-highlights-progress.png)

Update sync frequency

![update-sync-frequency](/screenshots/update-sync-frequency.png)

Select account

![select-account](</screenshots/select-account.png>)

## Demo

![demo](/screenshots/apple-notes-readwise-demo.gif)

## Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/Scarvy/apple-notes-readwise.git
   cd <repo>
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the app in development mode:
   ```bash
   npm start
   ```

4. Build the app for production:
   ```bash
   npm run make
   ```

---

## Technical Details

### Built With

- [Electron](https://www.electronjs.org/)
- [TypeScript](https://www.typescriptlang.org/)
- [AppleScript](https://en.wikipedia.org/wiki/AppleScript) and [Apple Shortcuts](https://support.apple.com/guide/shortcuts-mac/welcome/mac)

---

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository.
2. Create a new branch:
   ```bash
   git checkout -b feature-name
   ```
3. Commit your changes:
   ```bash
   git commit -m "Add feature"
   ```
4. Push to the branch:
   ```bash
   git push origin feature-name
   ```
5. Submit a pull request.

---

## Known Limitations

- Only supports macOS due to reliance on AppleScript and Apple Shortcuts.
- Requires the `Import Markdown to Notes` shortcut (see [Required Shortcut](#required-shortcut)).
- Syncs one book at a time, because concurrent shortcut runs can race.
- Appends can't be verified: if the shortcut fails during an append, the app can't tell.
- The shortcut only receives a folder name, so the selected Apple Notes account isn't used when creating notes.
- Requires the Apple Notes app to be installed and configured.

---

## License

This project is licensed under the [GNU GENERAL](LICENSE).

---

## Support

Please see our [Documentation](https://docs.readwise.io/readwise/docs/exporting-highlights/apple-notes) or email us at [hello@readwise.io](mailto:hello@readwise.io) 🙂
