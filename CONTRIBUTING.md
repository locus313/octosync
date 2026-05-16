# Contributing to Octosync

Thanks for helping improve Octosync. Sync plugins can affect a whole vault, so changes should be small, tested, and conservative.

## Local Setup

Install dependencies:

```bash
npm install
```

Build the plugin:

```bash
npm run build
```

Run the test suite:

```bash
npm test
```

Run the development watcher:

```bash
npm run dev
```

Install into a local test vault:

```bash
npm run local-install -- "/path/to/Your Test Vault"
```

Use a throwaway vault while developing sync behavior.

## Test Expectations

Before opening a pull request, run:

```bash
npm test
npm run build
```

For sync engine, GitHub API, conflict handling, deletion behavior, or settings changes, add or update focused tests under `tests/`.

The E2E suite launches Obsidian with a disposable vault and uses a throwaway GitHub repository:

```bash
cp env.e2e.sample .env.e2e
# Fill in OCTOSYNC_E2E_GITHUB_TOKEN, OCTOSYNC_E2E_OWNER, and OCTOSYNC_E2E_REPO.
npm run test:e2e
```

Only use a repository dedicated to testing. The E2E harness creates temporary branches and disposable vaults under `tmp/e2e/`.

## Sync Safety

When changing sync logic:

- Prefer planning changes before applying them.
- Preserve conflict detection over guessing user intent.
- Avoid partial local mutations if a remote write fails.
- Treat deletes as high-risk and test both local and remote delete cases.
- Keep `.obsidian/**` and `.octosync/**` excluded from vault file sync.
- Consider mobile and non-developer machines; do not add a local Git dependency.

If a behavior could overwrite, delete, or rename user notes, include tests for the failure and conflict paths as well as the happy path.

## Screenshots

Regenerate the settings screenshot with:

```bash
npm run screenshot:settings
```

The helper uses a disposable vault under `tmp/screenshots/` and refuses to run while Obsidian is already open.

## Release Notes

Octosync releases must keep these files in sync:

- `manifest.json`
- `versions.json`
- `package.json`
- `package-lock.json`

The GitHub release tag must match `manifest.json.version`. Release assets are built and uploaded by the release workflow:

- `main.js`
- `manifest.json`
- `styles.css`

## Reporting Issues

When reporting sync issues, include:

- Obsidian version and platform.
- Octosync version.
- Sync mode and relevant settings.
- Whether the issue involved local changes, remote changes, deletes, or conflicts.
- Any redacted debug log output if debug logging was enabled.

Do not include GitHub tokens or private note contents.
