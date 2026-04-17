# Jane Chart Assistant — Installation & Usage

This extension exports patient chart PDFs from Jane App in bulk. It runs locally in your Chrome browser — no data is sent anywhere other than directly between your browser and Jane App's own servers.

## What you need

- **Google Chrome** (or any Chromium-based browser: Edge, Brave, Arc). Safari and Firefox are not supported.
- A **Jane App login** with permission to view the charts you want to export.
- The **`jane-chart-assistant.zip`** file (the one sent to you).

## 1. Install the extension

The extension is not yet on the Chrome Web Store, so installation is manual. One-time setup, about two minutes.

1. **Unzip the file you received.** Save the unzipped folder somewhere you won't accidentally move or delete it — for example, `Documents/jane-chart-assistant`. If you delete the folder later, the extension will break.

2. **Open the Chrome extensions page.** Type the following into your address bar and press Enter:
   ```
   chrome://extensions
   ```

3. **Enable Developer mode.** In the top-right corner of the extensions page, flip the **Developer mode** switch to on.

   ![developer mode toggle location: top-right of chrome://extensions]

4. **Click "Load unpacked"** (button appears top-left after Developer mode is on).

5. **Select the unzipped folder** from step 1 (the folder, not a file inside it — the one that contains `manifest.json`).

6. The extension should now appear in the list as **Jane Chart Assistant** with the Brightlight logo. Make sure its toggle is on.

7. **(Recommended) Pin it to the toolbar.** Click the puzzle-piece icon in Chrome's toolbar, find "Jane Chart Assistant", and click the pin icon next to it. The logo now sits in your toolbar for one-click access.

### What "Developer mode" means for you

Chrome will show a yellow banner at the top of the window every time it starts, saying "Disable developer mode extensions." You can ignore it — just click **×** to dismiss. The banner is a safety reminder, not an error.

Do **not** click "Disable" in that banner. If you do, just re-enable the extension at `chrome://extensions`.

## 2. Use the extension

1. **Click the extension icon** in your Chrome toolbar (the Brightlight logo). A side panel opens on the right side of the window.

2. **Click "Export Charts"** at the bottom of the panel.

3. **Fill in the form:**

   | Field | What to enter | Example |
   |---|---|---|
   | Clinic Name | The subdomain from your Jane URL. If your Jane App lives at `https://yourclinic.janeapp.com`, the subdomain is `yourclinic`. | `yourclinic` |
   | Email | The email you use to sign in to Jane App. | `jane.doe@example.com` |
   | Password | Your Jane App password. | (your password) |
   | Number of Threads | How many charts to work on in parallel. 4 is a good default; 1 is safest; 8 is fastest but more likely to trigger Jane's rate limits. | `4` |
   | Max Patient ID (optional) | Stop after this patient ID is processed. Leave blank to go through every patient. | leave blank |

4. **Click Start.**

5. **Chrome will show a permission dialog:**

   > Allow "Jane Chart Assistant" to
   > Read and change your data on `yourclinic.janeapp.com`

   **Click "Allow".** This grants the extension access to *only* your clinic's subdomain — not to any other Jane clinic or other websites. The grant persists, so you only see this dialog the first time you export from each clinic.

6. The extension will:
   - Open one browser tab per thread (so if you picked 4 threads, you get 4 new tabs).
   - Automatically log into each tab.
   - Start walking through patient records, downloading each chart as a PDF.

   **Do not close the tabs** while the export is running. You can minimize the browser or switch to other windows, but the tabs need to stay open.

7. **Watch the side panel for progress.** It shows:
   - **PDFs Downloaded** — running count of successfully saved files.
   - **Users Finished** — running count of patients whose charts are all done.
   - **Errors** — any failures. Normal to see a few "rate limit detected" or "retry" messages; the extension handles these automatically.

8. **To stop early:** click the red **Stop Export** button in the side panel. The extension will close the worker tabs and stop adding to Downloads.

## 3. Where are the files?

All PDFs land in your normal **Downloads** folder, inside a subfolder called `jane-scraper/`. Within that, each patient gets their own folder:

```
~/Downloads/
└── jane-scraper/
    ├── 42_John_Doe/
    │   ├── Consultation_Note__123.pdf
    │   ├── Followup__145.pdf
    │   └── ...
    ├── 43_Jane_Smith/
    │   ├── Initial_Assessment__201.pdf
    │   └── ...
    └── ...
```

The folder name is `<patientID>_<PatientName>`. Within each folder, the filename is the chart type + a unique ID.

**If you run the extension a second time**, it detects already-downloaded files and skips them, so you can safely resume after an interruption.

## 4. Troubleshooting

| Symptom | What to do |
|---|---|
| Chrome banner: "Disable developer mode extensions" | Click **×** to dismiss. Don't click Disable. |
| Side panel doesn't open when you click the icon | Refresh the extensions page at `chrome://extensions`, toggle the extension off and on, try again. |
| Permission dialog doesn't appear | Check that you typed a valid clinic subdomain (no `https://`, no `.janeapp.com` — just the clinic name). |
| "Login failed" in the status log | Double-check the email and password by logging in manually at `https://<clinic>.janeapp.com` first. Note the admin URL; some clinics require a specific staff account. |
| Lots of "rate limit detected" messages | Normal. The extension pauses and resumes automatically. If it's constant, reduce the thread count (try 2 or 1) and restart. |
| Browser laptop goes to sleep mid-run | In macOS: System Settings → Lock Screen → "Start Screen Saver when inactive: Never", and "Turn display off on battery when inactive: Never". In Windows: Settings → Power → Screen and sleep → set both to Never. |
| Export stops / all tabs go idle | Check the side panel for error messages. Click Stop Export, wait a few seconds, and click Export Charts again to resume — already-downloaded files will be skipped. |
| Need to remove the extension | `chrome://extensions` → find Jane Chart Assistant → click **Remove**. |

## 5. Privacy note

- The extension does **not** send patient data, credentials, or usage information anywhere other than directly between your browser and Jane App's own servers.
- All exported PDFs are stored only on your local computer.
- Credentials are held in Chrome's local storage only while an export is running and are never transmitted elsewhere.
- See `PRIVACY_POLICY.md` in the extension folder for the full policy.
