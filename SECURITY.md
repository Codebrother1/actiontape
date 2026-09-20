# Security Policy

ActionTape is experimental pre-1.0 software. The initially supported release
line will be `0.1.x` once the first public release is made; earlier states are
unsupported.

## Reporting a vulnerability

Please do **not** file security-sensitive reports as public issues.

A private vulnerability-reporting destination has not been activated yet.
Once the public repository exists, reporters should use GitHub's private
security advisory mechanism (Security → "Report a vulnerability") if enabled.

> **Release task:** the private reporting destination must be activated
> before the public release. This file intentionally contains no contact
> address yet — do not treat it as complete until then.

## Scope notes

`.agentlog` recordings may contain sensitive data from recorded tool traffic
(credentials, personal data, file contents). ActionTape does not currently
provide automatic redaction — treat recordings as sensitive artifacts.
