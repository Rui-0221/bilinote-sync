# Changelog

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
