# Better ePub

Better ePub is a private, local-first EPUB 2 and EPUB 3 reader. Imported books are parsed and stored inside the browser; the application does not upload them.

Public reader: **https://better-epub.js.org/**

## Current MVP capabilities

- Local drag-and-drop and file-picker imports
- EPUB package, metadata, spine, cover, and navigation parsing
- Readium TypeScript Toolkit and Readium CSS rendering
- Paginated and continuous reading modes
- One- and two-column layouts, typography, spacing, alignment, and themes
- Durable reading position, reading progress, and per-book preferences
- Table of contents, book search, highlights, notes, and bookmarks
- Keyboard page navigation, bookmarking, and touch swipes
- Markdown and JSON annotation export
- Original EPUB download for backup
- IndexedDB storage with persistent-storage status
- Installable PWA and offline app shell
- GitHub Pages deployment workflow

## Privacy and security model

EPUB files are untrusted archives. Imports preflight archive entries before decompression and enforce archive, resource-count, expanded-size, per-resource, normalized-path, and XML-entity limits. Remote and absolute publication paths are disabled. Reading copies of HTML, XHTML, and SVG resources are sanitized before storage to remove authored scripts, event handlers, active embeds, refresh directives, and scriptable URLs; the untouched archive is retained only for explicit backup. Direct publication responses also carry a restrictive CSP, sandbox, and permissions policy, while Readium's generated frames prevent publication network access and forms.

The source EPUB and extracted resources are stored under the `better-epub` browser origin in IndexedDB. Browser storage is device- and origin-specific. Users should keep their source EPUB files and export annotations regularly.

## Development

Requirements: Node.js 22 and npm 10 or later.

```bash
npm ci
npm run dev
```

Validation:

```bash
npm run check
npm run build
```

The development build enables the PWA service worker because the Readium resource bridge uses same-origin virtual book URLs. After the first load, reload once if the browser has not yet taken control of the page.

## Deploying to GitHub Pages

1. Create a GitHub repository and push this project to its `main` branch.
2. In **Settings → Pages**, select **GitHub Actions** as the source.
3. The `Test and deploy Better ePub` workflow validates and publishes `dist/`.
4. The production custom domain is `better-epub.js.org`; keep it configured in the Pages settings before inviting users to create local libraries.
5. Enable **Enforce HTTPS**.

The Vite build uses relative production asset paths, so it works at either `https://user.github.io/repository/` or a custom-domain root. A custom domain should be adopted early: changing origins later creates a new, separate browser-storage area.

The selected domain is recorded in `public/CNAME` so it is included in every build artifact. Because this project deploys with GitHub Actions, the same domain must also remain configured in **Settings → Pages**.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Right arrow, Page Down, Space | Next page |
| Left arrow, Page Up | Previous page |
| B | Bookmark current location |
| Ctrl/Command + F | Search this book |

## Known MVP boundaries

- DRM-protected books are not supported.
- KFX is not supported; DRM-free MOBI/AZW3 conversion is not yet bundled.
- File-handler installation is a Chromium enhancement; drag-and-drop works across the supported web experience.
- Search currently navigates to the matching chapter rather than the exact word occurrence.
- Browser storage can still be removed explicitly by the user, even when persistent storage is granted.
