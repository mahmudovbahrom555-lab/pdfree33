# Security policy

PDFree handles documents in the browser, so security reports about parsing, file handling, dependency loading, and unintended data transmission are especially important.

## Report vulnerabilities privately

**Do not publish exploit details, sensitive PDFs, credentials, or private user data in a public GitHub issue.**

1. If this repository offers GitHub's **Report a vulnerability** action under its Security tab, use that private reporting channel.
2. If private reporting is not available, open a public issue titled **Request a private security contact** *without vulnerability details*. Ask a maintainer to arrange a private channel before sharing the report.

For a private report, include the affected feature, reproducible steps, browser/version where relevant, impact, and a sanitized or synthetic test case. Please avoid testing against other people's data or disrupting the live service.

## Scope and expectations

Reports affecting the current `main` branch or the live website are most actionable. Older versions and third-party dependencies may require separate coordination.

Local document processing reduces the need to upload PDF contents; it does not eliminate browser, dependency, malicious-file, or network risks. The site may request assets and send usage analytics or feedback, as explained in [README.md](README.md).

We will review reports as capacity allows; this policy does not promise a specific response or fix deadline. Please allow maintainers an opportunity to investigate before public disclosure.
