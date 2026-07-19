// Bundle entry point for the vendored syntax-highlighter used by the chat webview.
//
// This file is NOT loaded directly by the webview — it is the esbuild entry point
// that produces `media/highlight-bundle.js`, a single self-contained IIFE bundling
// highlight.js's core plus a curated set of common languages. Keeping this as a
// build step (rather than hand-vendoring highlight.js) means `npm run build:media`
// can be re-run to pick up a version bump without manual copy/paste.
//
// Only a subset of highlight.js's ~190 languages is registered, to keep the vendored
// bundle small; extend `LANGUAGES` below to add more.
import hljs from "highlight.js/lib/core";

import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  php,
  plaintext,
  powershell,
  python,
  r,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, def] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, def);
}

// A few common fence-info-string aliases that highlight.js doesn't map by default.
hljs.registerAliases(["sh", "zsh"], { languageName: "bash" });
hljs.registerAliases(["ts"], { languageName: "typescript" });
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.registerAliases(["c++"], { languageName: "cpp" });
hljs.registerAliases(["cs"], { languageName: "csharp" });
hljs.registerAliases(["rb"], { languageName: "ruby" });
hljs.registerAliases(["ps1", "pwsh"], { languageName: "powershell" });
hljs.registerAliases(["dockerfile", "docker"], { languageName: "dockerfile" });
hljs.registerAliases(["html", "htm", "svg"], { languageName: "xml" });
hljs.registerAliases(["txt", "text"], { languageName: "plaintext" });

// Exposed as a single global; media/main.js reads `window.hljs` and never imports
// this module directly (the webview loads `media/highlight-bundle.js` as a
// pre-built script, not through a module resolver).
window.hljs = hljs;
