# Security Policy

ActionTape is experimental pre-1.0 software. The initially supported release
line will be `0.1.x` once the first public release is made; earlier states are
unsupported.

## Reporting a vulnerability

Please do **not** file security-sensitive reports as public issues.

Report vulnerabilities privately through GitHub's private vulnerability
reporting for this repository:

https://github.com/Codebrother1/actiontape/security/advisories/new

(Security → "Report a vulnerability".)

## Scope notes

`.agentlog` recordings may contain sensitive data from recorded tool traffic
(credentials, personal data, file contents). ActionTape does not currently
provide automatic redaction — treat recordings as sensitive artifacts.
