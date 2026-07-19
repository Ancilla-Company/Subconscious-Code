// Builds the vendored syntax-highlighter bundle used by the chat webview.
//
// `media/src/highlight-bundle.js` imports highlight.js's core module plus a curated
// set of languages via normal npm module resolution; this script bundles that into a
// single dependency-free IIFE at `media/highlight-bundle.js`, which the webview loads
// as a plain <script> tag (there is no module resolver inside the webview, and the
// strict CSP disallows any remote script source). Re-run via `npm run build:media`
// whenever `media/src/highlight-bundle.js` or the highlight.js version changes.
const esbuild = require("esbuild");
const path = require("path");

const entry = path.join(__dirname, "..", "media", "src", "highlight-bundle.js");
const outfile = path.join(__dirname, "..", "media", "highlight-bundle.js");

esbuild
  .build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    logLevel: "info",
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
