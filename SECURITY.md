# Security policy

## Supported versions

Security fixes target the latest GitCode release and the `main` branch.
Older builds may require an update before a fix can be provided.

## Report a vulnerability

Email [duanzhongxing@foxmail.com](mailto:duanzhongxing@foxmail.com) with the
subject **GitCode security report**. You may also use **Report a vulnerability**
on the [Security Advisories page](https://github.com/dzxing/gitcode/security/advisories)
when GitHub private vulnerability reporting is available.

Include the GitCode version, operating system, reproduction steps, expected
and actual behavior, and potential impact. Remove credentials and private
project data from attachments. Do not publish vulnerability details,
proof-of-concept code, credentials or private logs in public issues.

We will review reports and coordinate disclosure after investigating the issue.
Response times depend on maintainer availability; no fixed response time is promised.

## Dependencies and credentials

GitCode uses the system Git installation. Reports should identify both the
GitCode version and `git --version` when Git behavior is involved.
Never submit SSH private keys, access tokens or account passwords.

## Required checks for changes

- `bun install` installs local pre-commit and pre-push scans. Existing hooks are preserved and chained;
  an existing custom `core.hooksPath` is left untouched and requires manual integration.
- The first scan downloads Gitleaks 8.30.1 from its official release and verifies the pinned archive
  SHA256. Windows requires `tar` (included in Windows 11). Run `bun run secrets:install` to prepare
  the scanner before working offline. Download, configuration and scanner failures block the operation.
- Pre-commit scans the staged changes, including low-entropy password assignments. Pre-push scans
  all reachable local history. Run `bun run check:secrets` manually for the same history check.
- Every pull request runs the required **Secret scan** and **Quality checks** jobs without path filters.
  Secret scanning uses the base branch policy so a pull request cannot disable its own detection rules.
  Inline `gitleaks:allow` comments and repository `.gitleaksignore` entries cannot bypass these scans.
- Do not commit real credentials in source, fixtures, screenshots, logs or release attachments.
  Use environment variables or a credential manager. Scans redact matching values from their output.
  Git hooks can be bypassed locally; required server checks protect merges to `main` independently.
- A credential already pushed to any branch must be revoked or rotated immediately, even if a later
  commit removes it. The Actions scan detects pushed content after upload; it does not prevent that
  initial exposure. Pattern scanning cannot recognize every possible secret or inspect screenshot text.
