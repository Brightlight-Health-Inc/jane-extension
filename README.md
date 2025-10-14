# Jane App Scraper

Chrome extension for automatically scraping patient chart PDFs from Jane App.

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select this folder

## Usage

1. Click the extension icon to open the side panel
2. Enter your Jane App credentials:
   - Clinic name (e.g., `bedfordskinclinic`)
   - Email
   - Password
3. Click **Start Scrape**
4. The extension will:
   - Navigate to Jane App
   - Log you in automatically
   - Iterate through patient IDs
   - Download all chart PDFs for each patient
   - Create a ZIP file per patient
   - Stop after 5 consecutive patients not found

## Download Location

All files are saved to: `Downloads/jane-scraper/`

Each patient gets a single ZIP file named `PatientName.zip` containing all their charts.

## Configuration

You can change the starting patient ID in `content.js`:

```javascript
const STARTING_INDEX = 1; // Change this to start from a different patient ID
```

## Features

- ✅ Automatic login
- ✅ Resume on page reload (state persisted)
- ✅ External skip detection (patient doesn't exist)
- ✅ Internal skip handling (patient exists but has no charts)
- ✅ ZIP archives per patient
- ✅ Automatic cleanup of individual PDFs after zipping
- ✅ Stop button to interrupt scraping at any time

## Notes

- The extension stops after finding 5 consecutive patients that don't exist
- Patients with no charts are skipped (internal skip - doesn't count toward the limit)
- All state is saved across page navigations, so you can reload without losing progress
