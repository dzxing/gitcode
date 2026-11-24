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
