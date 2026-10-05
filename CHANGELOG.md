# Changelog

## 1.4.3

- Fix community clean-build verification by giving tracked source inputs distinct names (`src/plugin.cjs` and `src/plugin.css`), so cleaning release asset filenames throughout the checkout does not remove the source.
- Reproduce recursive removal of `main.js` and `styles.css` in an isolated build test, then verify exact, repeatable outputs. Include the CommonJS source in the Obsidian lint checks.
- Keep the 1.4.2 import behavior, cache safeguards and existing settings unchanged.

## 1.4.2

- Clean verified, imported episodes independently while other episodes are generating. Preserve downloads shared with queued, running, failed/retryable or unimported tasks.
- Read local task requests and series receipts to identify pending downloads, including first-episode filename aliases. Explicitly removed failed tasks can release their cache references; still-running tasks remain protected.
- Defer cleanup when task identity or series metadata cannot be resolved. Damaged completed results and missing status records continue to protect their downloads.
- Recheck task references and file/directory identity immediately before deletion. Preserve rewritten files and newly completed, unimported results found during the final scan.
- Add 24 isolated regression cases for per-episode cleanup and cache retention. Selective import and saved preferences remain supported; destructive cleanup stays off for new installations.

## 1.4.1

- Fix clean build verification: generate root installation assets from tracked `src/main.js` and `src/styles.css`, even when the previous outputs have been removed.
- Add a regression test for missing outputs and repeatable release assets.
- Add GitHub Actions checks on Windows and Linux and signed build provenance for all three release assets. Tagged releases are published only after verification and attestation.
- Use the public npm registry for reproducible dependency installation on hosted runners. Import behavior and saved settings are unchanged.

## 1.4.0

First community release candidate, based on the local importer.

- Explicit restore for deleted notes, deduplication after moves/renames and YAML property edits.
- Encode screenshot URLs, verify newly linked images, reject destination folders redirected outside the vault.
- Invalidate selections when source/destination/image settings change and serialize immutable state snapshots.
- Restrict cache cleanup to verified video-ID filenames; disable shared images and destructive cleanup for new installations while preserving existing preferences.
- Remove machine-specific source defaults, use a community-compatible manifest, and document privacy, dependencies, platform limits and publication.
- Adopt declarative settings for Obsidian 1.13 settings search while preserving the wrapped import-history data on every save.
