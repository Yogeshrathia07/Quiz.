# Working rules

- Before choosing colors, generate the palette with the "color" MCP server from the brand color, and check every text/background pair with "accesslint" (minimum 4.5:1 contrast).
- After any UI change, use "chrome-devtools" to screenshot the page at 375px, 768px and 1280px, run a Lighthouse audit (accessibility 90+), and check the console for errors.
- Before finishing any task, scan changed files with "semgrep" and fix all findings.
