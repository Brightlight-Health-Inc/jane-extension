# Guide artifacts

- `guide.html` — source for the user-facing PDF. Edit this when the install/usage flow changes.
- `screenshots/` — real screenshots that get embedded into `guide.html`. Currently empty; `guide.html` uses styled HTML mock-ups as placeholders until real screenshots are dropped in here.

## Regenerating the PDF

From the repo root:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new \
  --disable-gpu \
  --no-pdf-header-footer \
  --print-to-pdf=Jane_Chart_Assistant_Guide.pdf \
  file://$PWD/docs/guide.html
```

The output PDF goes to the repo root so it's easy to attach to emails.
