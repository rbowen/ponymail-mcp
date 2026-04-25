# Security Policy

## Supported Versions

Only the latest `main` branch is supported. Please ensure you are running the
latest release before reporting vulnerabilities.

## Reporting a Vulnerability

Please **do not** open public GitHub issues for security vulnerabilities.

Instead, report privately using GitHub's
[private vulnerability reporting](https://github.com/rbowen/ponymail-mcp/security/advisories/new)
("Security" tab → "Report a vulnerability").

We aim to acknowledge reports within **5 business days** and provide a fix
or remediation plan within **30 days** for confirmed issues.

## Scope

In scope:

- Authentication handling (session cookie storage, OAuth helper flow)
- Input validation on MCP tool arguments passed to the PonyMail API
- Supply-chain issues in dependencies or GitHub Actions used by this repo

Out of scope:

- Vulnerabilities in the upstream Apache PonyMail service itself — please
  report those to the [ASF security team](https://www.apache.org/security/).

## Disclosure

We follow coordinated disclosure. Once a fix is released, we will publish a
GitHub Security Advisory crediting the reporter (unless anonymity is
requested).
