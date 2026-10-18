
# Working rules

- Before choosing colors, generate the palette with the "color" MCP server from the brand color, and check every text/background pair with "accesslint" (minimum 4.5:1 contrast).
- After any UI change, use "chrome-devtools" to screenshot the page at 375px, 768px and 1280px, run a Lighthouse audit (accessibility 90+), and check the console for errors.
- Before finishing any task, scan changed files with "semgrep" and fix all findings.

# Design review checklist

Every colour, size, gap, corner and shadow comes from `client/src/styles/tokens.css`. Run `npm run lint:css` after any style change: it fails on hard-coded colours, font sizes, spacing and radii outside tokens.css. If a value you need is missing, add a token there instead of a one-off.

- **Visual hierarchy:** blue is the main colour (`--primary`, `--primary-fill` behind white text): main actions, links, the brand, the chart bars. Secondary actions are neutral grey (`.button-secondary`, `--secondary-fill`). The accents are for small things only: teal (`--accent`) for the open view, green for success, pink (`--highlight-text`) for highlights, red for danger, orange (`--warn`) for warnings such as Block, and yellow (`--gold`) for notices and Review. Each screen or dialog has one main action (`.button-primary`). Headings come first, then body text (`--text`), then supporting text (`--text-soft` / `--text-muted`). Red, amber and green are for feedback only, never decoration.
- **Spacing rhythm:** margins, padding and gaps use the 4px scale (`--space-*`). Related items sit closer together than unrelated ones, and the same kind of gap gets the same token on every screen.
- **Type scale:** only the `--text-*` sizes (`clamp()` is allowed for large fluid headings). Don't add a size to tell two things apart; use weight or colour.
- **Grid alignment:** content lines up with its container's padding edge. Table columns, button widths in a row and card grids stay aligned at 375px, 768px and 1280px, with no horizontal scroll on phones.
- **Consistent component states:** every interactive element has distinct hover, `:focus-visible`, active/pressed and disabled states. Copy the existing pattern for that component (outlined at rest, filled on hover for Block/Delete/View/Unblock; dark circle with a red ✕ for close) instead of inventing a new one. Hover uses the `-hover` tokens, so hover never looks the same as rest.
- **Contrast:** text at least 4.5:1 against what is really behind it (3:1 for large text, icons and borders that carry meaning), checked with the "color" MCP and "accesslint". White text goes on the `-fill` colours, never on the bright accents. See-through colours are built from channel tokens, `rgb(var(--primary-rgb) / .12)`, so they follow the palette.
