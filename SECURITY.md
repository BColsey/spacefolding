# Security Policy

## Reporting Security Vulnerabilities

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via one of the following methods:

- Open a private security advisory on GitHub: [Security Advisories](https://github.com/BColsey/spacefolding/security/advisories)
- Email the maintainer directly

You should receive a response within 48 hours. If you do not, please follow up to ensure we received your message.

## What to Include

Please include the following information in your report:

- Description of the vulnerability
- Steps to reproduce or proof-of-concept
- Affected versions (if known)
- Potential impact
- Suggested fix (if available)

## Supported Versions

| Version | Supported |
|---------|-----------|
| main (latest) | ✅ |
| Older versions | ❌ |

## Security Considerations

Spacefolding is designed to run **locally** and does not require cloud services by default. However, be aware of:

- **Local model downloads**: When using local embedding models, files are downloaded from HuggingFace. Verify model integrity and source trust.
- **SQLite database**: The local database may contain ingested source code and conversation data. Protect the `./data` directory accordingly.
- **MCP server**: When exposed via SSE transport, the MCP server is unauthenticated. Only expose it on trusted networks.
- **File ingestion**: The CLI reads arbitrary files from the host filesystem. Restrict ingest paths to intended directories.

## Disclaimer

This software is provided "as is" without warranty of any kind. The authors are not responsible for any data loss, security incidents, or damages resulting from the use of this software. See the [LICENSE](LICENSE) for full terms.
