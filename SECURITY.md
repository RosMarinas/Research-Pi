# Security Policy

Research Pi executes model-generated code and coordinates local or remote
research work. Security reports are welcome, especially when behavior crosses
the documented project, credential, approval, or session boundaries.

## Supported branches

| Branch | Status |
|---|---|
| `main` | Supported |
| `windows-research-pi` | Preview; security reports and fixes are handled on a best-effort basis |
| Older commits and other development branches | Not supported |

Research Pi does not yet publish stable release tags. Reproduce a report on the
latest relevant branch when practical.

## Reporting a vulnerability

Prefer GitHub's private vulnerability reporting form under the repository's
**Security** tab. Include the affected commit, operating system, expected
boundary, observed behavior, impact, and the smallest safe reproduction.

If private reporting is unavailable, open a minimal public issue requesting a
private contact channel. Do not include exploit details, credentials, private
paths, research data, session transcripts, or trace output in that issue.

Reports are handled on a best-effort basis; this project does not currently
promise a response or remediation SLA. Please allow the maintainer an
opportunity to investigate before public disclosure.

## Scope

Security-relevant examples include:

- sandbox escape or access beyond the current project without approval;
- credential, SSH-agent, keychain, session, or trace disclosure;
- bypass of a displayed host-capability approval;
- cross-project or cross-session message and authority confusion;
- sensitive Runtime data entering Git or an npm package;
- unsafe WSL access that crosses the documented Windows filesystem boundary.

Ordinary functional bugs and research-result disagreements can use the public
issue tracker without sensitive attachments.

For the implemented trust model, local-data rules, known limitations, and
release checks, see [Security model and local research data](docs/security-model.md).
