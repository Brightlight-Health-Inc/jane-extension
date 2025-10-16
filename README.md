# Jane Chart Assistant

Chrome extension for healthcare professionals to efficiently export and organize patient chart PDFs from Jane App for record keeping and compliance purposes.

## Overview

Jane Chart Assistant streamlines the process of downloading patient charts from Jane App. Instead of manually clicking through each patient's charts one by one, this tool helps you export multiple charts in bulk, saving time on administrative tasks.

**Privacy First**: No data is collected or transmitted. All operations occur locally on your device. See [Privacy Policy](PRIVACY_POLICY.md) for details.

## Installation

### From Chrome Web Store (Recommended)
*Coming soon - pending review*

### Manual Installation (Developer Mode)
1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the extension folder

## Usage

1. Click the extension icon to open the Chart Assistant panel
2. Enter your Jane App credentials:
   - Clinic name (e.g., `yourClinicName` from `yourClinicName.janeapp.com`)
   - Email address
   - Password
   - Number of concurrent export threads (1-5)
3. Click **Start Export**
4. The assistant will:
   - Log into your Jane App account
   - Navigate through patient records
   - Download chart PDFs for each patient
   - Organize files into patient-specific folders
   - Continue until all patients are processed

## Download Location

All files are saved to: `Downloads/jane-scraper/`

Each patient gets their own folder: `PatientID_PatientName/` containing all their chart PDFs.

## Features

- ✅ Bulk chart export - save hours of manual clicking
- ✅ Multi-threaded processing for faster exports
- ✅ Automatic resume if interrupted
- ✅ Skip patients with no charts automatically
- ✅ Organized folder structure by patient
- ✅ Real-time progress tracking
- ✅ Stop/resume capability

## Privacy & Security

- **Zero data collection** - no analytics, no telemetry
- **Local storage only** - credentials never leave your device
- **No external servers** - communicates only with Jane App
- **You control your data** - all files saved locally
- See full [Privacy Policy](PRIVACY_POLICY.md)

## Compliance

This tool is designed to assist healthcare professionals with:
- Record keeping and archival requirements
- Compliance documentation
- Practice transition support
- Backup and disaster recovery

**Your Responsibility**: Users must ensure compliance with HIPAA, local regulations, and their organization's data handling policies.

## Support

For issues, questions, or feature requests, please open an issue on GitHub.

## License

Copyright © 2025. All rights reserved.
