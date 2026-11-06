# Translating PDFree

PDFree welcomes small, reviewable translation improvements. You do **not** need to understand the PDF processing engine to contribute wording, but please keep translation changes separate from functional changes.

## Understand the language coverage

There are **20 language configurations** in `data/tools-config.json`, but that does **not** mean 20 complete homepages.

- **16 full-homepage languages** (including English): `en`, `de`, `es`, `fr`, `pt`, `id`, `tr`, `vi`, `ru`, `ja`, `it`, `ko`, `nl`, `pl`, `zh-CN`, `ar`. The source of truth for this list is `HOMEPAGE_LANGS` in `scripts/build.py`.
- **4 scoped languages**: `fa`, `he`, `ur`, `bn`. These intentionally cover a limited set of tool pages and UI strings, rather than a full homepage. Missing UI keys in these locales may deliberately fall back to English; see `tests/i18n-parity.test.js`.

Please **do not** fill all missing scoped-locale keys or add a homepage as part of a simple translation fix.

## Find the right source file

| What you want to improve | Where to look |
| --- | --- |
| English UI strings and translation keys | `js/i18n.js` (`EN` object) |
| Non-English interactive UI strings | `js/locales/<locale>.js` (19 files, one per non-English locale) |
| Localized tool metadata and page settings | `data/tools-config.json` |
| Tool-page explanations and FAQ/HowTo copy | `data/content/<locale>/` (`.html` and `.json` files) |
| Tool-page rendering template | `scripts/templates/tool-page.html` (reference only; do not edit for a translation-only fix) |
| Existing terminology guidance | `docs/*-style-guide.md` (check claims against current code before reusing) |

English UI keys in `js/i18n.js` are the baseline. Other locales assign `window.PDFREE_LOCALE`; the app merges translations over the English defaults.

## Make one small change

1. Pick one language and a specific incorrect or unclear phrase. Describe what a user sees now and what you propose instead.
2. Edit **values**, not UI key names. Preserve placeholders such as `{filename}` and `{time}`, and keep any markup or formatting tokens the UI expects.
3. If updating a FAQ or HowTo entry, keep the existing JSON structure and check that the revised text answers the question. Avoid introducing new claims about functionality.
4. If adding homepage search synonyms in `search_tags`, check `js/config.js` and run the search-tag test below. Duplicates, very short tags and collisions with another tool can break search.
5. Do not modify `js/worker.js`, PDF processing logic, Cloudflare configuration or generated `dist/` files for a translation-only PR.

## Describe privacy and limits precisely

PDF files are processed locally in the browser; this does **not** imply that the website makes zero network requests. Assets may be requested over the network, and usage analytics or explicitly submitted feedback may be sent.

File-size caps vary by tool and device. Check `js/fileLimits.js` rather than writing "unlimited file size". Do not claim GDPR, RODO, KVKK, AVG or other legal compliance without a documented legal assessment. Also avoid unverified guarantees about offline availability, perfect conversion or lossless compression.

## Validate before opening a PR

From the repository root, install the Node dependencies and the Python build dependency as needed:

```sh
npm ci
python3 -m pip install jinja2
```

Run the relevant checks:

```sh
npm run check:i18n
node tests/i18n-parity.test.js
node tests/search-tags-completeness.test.js
python3 scripts/build.py
git diff --check
```

The build writes generated output to `dist/`; do **not** commit generated files unless the maintainers explicitly request them. If you only changed prose, a full test suite is optional for the initial PR; maintainers may request more checks. Report any failed or skipped checks honestly.

## Open a focused pull request

In your PR, include the affected language and page/tool, the original phrase, the proposed translation and why it is clearer. List the checks you ran and their results. Screenshots are welcome for visible UI text, but **do not upload private PDF documents** as examples.

If the change needs new translation keys, page layouts, or application behavior, open a separate issue first so the scope can be agreed on.
