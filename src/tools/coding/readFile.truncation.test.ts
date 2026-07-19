// Feature: agent-tools-and-settings, Property 12: Reads are truncated to the
// configured maximum and flagged.
//
// Validates: Requirements 4.5
//
// For any configured maximum read size within the range 1,024–104,857,600 bytes
// and any file content, `read_file` returns at most the configured maximum bytes
// and sets the truncation flag exactly when the content's byte length exceeds the
// maximum. When the content fits, the full content is returned and the truncation
// flag is absent.
//
// The property runs against a REAL temporary directory (created with
// `fs.mkdtempSync` under `os.tmpdir()`): each generated case writes a file, reads
// it through a `ReadFileTool` wired to a `DefaultWorkspacePathGuard` scoped to that
// directory, and asserts the byte cap and flag. Content is ASCII so a byte's length
// equals its character length, keeping the expected outcome fixed by construction
// (never re-derived from the tool's own logic) so a truncation bug is genuinely
// caught. To keep the property fast the tested maximum is drawn from the low end of
// the supported range (capped around 4,096 bytes) so no fast-check iteration ever
// allocates a large buffer. The two ends of the supported range are pinned by
// dedicated cases OUTSIDE the fast-check loop: the exact 1,024-byte lower bound, and
// the 104,857,600-byte (100 MB) upper bound (a SINGLE fixed-size case — allocating a
// ~100 MB buffer inside the property loop would OOM-crash the host).

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as fc from "fast-check";

import { DefaultWorkspacePathGuard } from "../pathGuard";
import type { ToolContext } from "../types";
import {
  MAX_MAX_READ_BYTES,
  MIN_MAX_READ_BYTES,
  ReadFileTool,
} from "./readFile";

/** Build an ASCII string of exactly `length` characters (byte length == length). */
function makeAsciiContent(length: number): string {
  const pattern = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < length) {
    out += pattern;
  }
  return out.slice(0, length);
}

describe("Property 12: reads are truncated to the configured maximum and flagged", () => {
  let baseDir: string;
  let rootDir: string;
  let filePath: string;
  let ctx: ToolContext;

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "readfile-trunc-"));
    rootDir = path.join(baseDir, "workspace");
    fs.mkdirSync(rootDir, { recursive: true });
    filePath = path.join(rootDir, "content.txt");

    const guard = new DefaultWorkspacePathGuard(() => [rootDir]);
    ctx = {
      guard,
      profile: undefined,
      signal: new AbortController().signal,
    };
  });

  after(() => {
    if (baseDir) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("caps output at the configured maximum and flags truncation iff content exceeds it", async () => {
    // Draw a maximum from the low end of the supported range (keeps files small and
    // the property fast) and a content length that straddles that maximum.
    const scenario = fc
      .integer({ min: MIN_MAX_READ_BYTES, max: 4_096 })
      .chain((max) =>
        fc.record({
          max: fc.constant(max),
          contentLen: fc.integer({ min: 0, max: max * 2 }),
        })
      );

    await fc.assert(
      fc.asyncProperty(scenario, async ({ max, contentLen }) => {
        const content = makeAsciiContent(contentLen);
        fs.writeFileSync(filePath, content, "utf8");

        const tool = new ReadFileTool({ maxReadBytes: max });
        const output = await tool.execute({ path: filePath }, ctx);

        const returnedBytes = Buffer.byteLength(output.content, "utf8");
        const shouldTruncate = contentLen > max;

        // Never returns more than the configured maximum.
        assert.ok(
          returnedBytes <= max,
          `returned ${returnedBytes} bytes, exceeds max ${max}`
        );

        if (shouldTruncate) {
          assert.strictEqual(output.truncated, true, "expected truncation flag");
          assert.strictEqual(returnedBytes, max, "truncated output must fill the max");
          assert.strictEqual(
            output.content,
            content.slice(0, max),
            "truncated content must be the leading prefix"
          );
        } else {
          assert.notStrictEqual(output.truncated, true, "did not expect truncation flag");
          assert.strictEqual(returnedBytes, contentLen, "full content byte length");
          assert.strictEqual(output.content, content, "full content must be returned");
        }
      }),
      { numRuns: 200 }
    );
  });

  it("returns the whole file when content length equals the maximum exactly", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MIN_MAX_READ_BYTES, max: 4_096 }),
        async (max) => {
          const content = makeAsciiContent(max);
          fs.writeFileSync(filePath, content, "utf8");

          const tool = new ReadFileTool({ maxReadBytes: max });
          const output = await tool.execute({ path: filePath }, ctx);

          assert.notStrictEqual(output.truncated, true);
          assert.strictEqual(output.content, content);
        }
      )
    );
  });

  it("enforces the lower-bound maximum of 1,024 bytes when a smaller max is requested", async () => {
    // A requested max below the range is clamped up to 1,024, so a 2,048-byte file
    // truncates to exactly 1,024 bytes and is flagged.
    const content = makeAsciiContent(2_048);
    fs.writeFileSync(filePath, content, "utf8");

    const tool = new ReadFileTool({ maxReadBytes: 1 });
    const output = await tool.execute({ path: filePath }, ctx);

    assert.strictEqual(Buffer.byteLength(output.content, "utf8"), MIN_MAX_READ_BYTES);
    assert.strictEqual(output.truncated, true);
    assert.strictEqual(output.content, content.slice(0, MIN_MAX_READ_BYTES));
  });

  // A SINGLE fixed-size case OUTSIDE the fast-check loop pins the 100 MB upper
  // bound. Requesting a maximum above the supported range clamps down to
  // 104,857,600 bytes, so a file just past that boundary truncates to exactly the
  // upper bound and is flagged. The ~100 MB buffer is allocated once here (never
  // inside a property iteration, which would OOM-crash the host).
  it("enforces the 104,857,600-byte upper-bound maximum and flags truncation", async function () {
    // A single ~100 MB write/read can exceed the shared 20s default timeout.
    this.timeout(120_000);

    const overflow = 4_096;
    // Build the oversized file efficiently: a repeating ASCII pattern (byte length
    // == character length) written straight from a Buffer, avoiding giant string
    // concatenation.
    const pattern = "abcdefghijklmnopqrstuvwxyz0123456789";
    const buffer = Buffer.alloc(MAX_MAX_READ_BYTES + overflow, pattern);
    fs.writeFileSync(filePath, buffer);

    // Request a max above the supported range; it must clamp to the upper bound.
    const tool = new ReadFileTool({ maxReadBytes: MAX_MAX_READ_BYTES + 1_000_000 });
    assert.strictEqual(tool.maxBytes, MAX_MAX_READ_BYTES, "requested max clamps to upper bound");

    const output = await tool.execute({ path: filePath }, ctx);

    assert.strictEqual(output.truncated, true, "oversized file must be flagged truncated");
    assert.strictEqual(
      Buffer.byteLength(output.content, "utf8"),
      MAX_MAX_READ_BYTES,
      "truncated output must fill exactly the upper-bound maximum"
    );
    // Light prefix check (a full ~100 MB string compare is avoided): the returned
    // content must be the leading bytes of the file, not shifted or garbage.
    assert.strictEqual(
      output.content.slice(0, pattern.length),
      pattern,
      "truncated content must be the leading prefix"
    );
  });
});
