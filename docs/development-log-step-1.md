# Development Log - Step 1

## Project name

무리없이부산

## Current step number

Step 1

## Completed implementations

- Removed the Kakao map tile-event timeout fallback from `frontend/js/course.js`.
- Kept mock map fallback only at the existing key-missing / SDK-load-failure boundaries in `initMaps()`.
- Added a regression test to prevent `tilesloaded`-based mock fallback from returning.
- Added the standard `mobile-web-app-capable` meta tag to `frontend/course.html`.
- Added `defer` to the external course page scripts in dependency order: `runtime-config.js`, `app.js`, `course.js`.

## Files modified

- `frontend/js/course.js`
- `frontend/course.html`
- `tests/test_frontend_fixes.py`
- `docs/development-log-step-1.md`

## What is currently stable

- `python -m pytest tests/test_frontend_fixes.py -q` passes with `9 passed`.
- Cursor lint diagnostics reported no new linter errors for the edited files.
- Normal Kakao map rendering is no longer overwritten by a delayed tile-load heuristic.

## What remains

- Browser-level visual verification can still be run on the live page to confirm the map stays visible after several seconds.
- Existing unrelated working tree changes remain untouched.

## Exact next implementation boundary

If continuing, verify the course detail page in a browser with a real Kakao JavaScript key and confirm:

- the map remains visible beyond the previous 2.5 second timeout window;
- SDK-load/key-missing cases still show the SVG summary map;
- the deprecated mobile web app capability warning no longer appears for `course.html`.

## Resume instructions

1. Open `무리없이부산`.
2. Review this log first.
3. Run `git status --short` to separate these changes from unrelated existing changes.
4. Start only from the browser verification boundary above.
