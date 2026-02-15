/**
 * Outbound Message Handler — Chunking and formatting for channel delivery.
 *
 * Handles:
 * - Text chunking at platform-specific limits
 * - Markdown-aware splitting (don't break code blocks)
 * - Markdown → Telegram HTML conversion
 * - Markdown → plain text for iMessage
 */

import type { OutboundFormatOptions } from "./types.js";

// ─── Text Chunking ───────────────────────────────────────────────

/**
 * Split text into chunks respecting a maximum size.
 * Attempts to break at paragraph boundaries, falling back to sentence/word boundaries.
 */
export function chunkText(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good break point
    let breakPoint = findBreakPoint(remaining, maxSize);
    if (breakPoint <= 0) {
      // No good break found — force break at maxSize
      breakPoint = maxSize;
    }

    chunks.push(remaining.substring(0, breakPoint).trimEnd());
    remaining = remaining.substring(breakPoint).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Find the best break point in text within maxSize.
 * Priority: paragraph break > code block boundary > sentence end > word boundary
 */
function findBreakPoint(text: string, maxSize: number): number {
  const searchRegion = text.substring(0, maxSize);

  // 1. Try paragraph break (double newline)
  const lastParagraph = searchRegion.lastIndexOf("\n\n");
  if (lastParagraph > maxSize * 0.3) return lastParagraph + 2;

  // 2. Try single newline
  const lastNewline = searchRegion.lastIndexOf("\n");
  if (lastNewline > maxSize * 0.3) return lastNewline + 1;

  // 3. Try sentence end
  const sentenceEnd = findLastSentenceEnd(searchRegion);
  if (sentenceEnd > maxSize * 0.3) return sentenceEnd + 1;

  // 4. Try word boundary (space)
  const lastSpace = searchRegion.lastIndexOf(" ");
  if (lastSpace > maxSize * 0.3) return lastSpace + 1;

  // 5. Force break
  return maxSize;
}

/**
 * Find the last sentence-ending position in text.
 */
function findLastSentenceEnd(text: string): number {
  // Match sentence endings: period/exclamation/question followed by space or end
  let lastEnd = -1;
  const regex = /[.!?](?:\s|$)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    lastEnd = match.index + 1;
  }
  return lastEnd;
}

// ─── Markdown-Aware Chunking ─────────────────────────────────────

/**
 * Chunk text while being aware of markdown code blocks.
 * Avoids splitting inside fenced code blocks (``` ... ```).
 */
export function chunkMarkdownAware(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  // Identify code block ranges
  const codeBlockRanges = findCodeBlockRanges(text);
  const chunks: string[] = [];
  let remaining = text;
  let offset = 0;

  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }

    // Find break point, avoiding code block interiors
    let breakPoint = findBreakPoint(remaining, maxSize);

    // Check if break point falls inside a code block
    const absoluteBreak = offset + breakPoint;
    for (const range of codeBlockRanges) {
      if (absoluteBreak > range.start && absoluteBreak < range.end) {
        // Break is inside a code block — try before the block
        const beforeBlock = range.start - offset;
        if (beforeBlock > maxSize * 0.2) {
          breakPoint = beforeBlock;
        }
        // Otherwise accept the break (can't avoid it for very long code blocks)
        break;
      }
    }

    if (breakPoint <= 0) breakPoint = maxSize;

    chunks.push(remaining.substring(0, breakPoint).trimEnd());
    remaining = remaining.substring(breakPoint).trimStart();
    offset += breakPoint;
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Find all fenced code block ranges in text.
 */
function findCodeBlockRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const regex = /```[\s\S]*?```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

// ─── Markdown to Telegram HTML ───────────────────────────────────

/**
 * Convert a subset of Markdown to Telegram-compatible HTML.
 *
 * Supported conversions:
 * - **bold** → <b>bold</b>
 * - *italic* → <i>italic</i>
 * - `code` → <code>code</code>
 * - ```lang\ncode``` → <pre><code class="language-lang">code</code></pre>
 * - [text](url) → <a href="url">text</a>
 * - ~~strike~~ → <s>strike</s>
 *
 * Characters &, <, > are escaped to HTML entities.
 */
export function markdownToTelegramHtml(markdown: string): string {
  let html = markdown;

  // First: escape HTML entities in non-code regions
  // We'll handle code blocks separately to preserve their content

  // Extract code blocks, replace with placeholders
  // Use \x00 sentinel to prevent placeholders from being matched by markdown regexes
  const codeBlocks: string[] = [];
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const escapedCode = escapeHtml(code.trimEnd());
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    const placeholder = `\x00CB${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre><code${langAttr}>${escapedCode}</code></pre>`);
    return placeholder;
  });

  // Extract inline code
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_match, code) => {
    const placeholder = `\x00IC${inlineCodes.length}\x00`;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // Escape HTML entities in remaining text
  html = escapeHtml(html);

  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  html = html.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_ (but not inside words)
  html = html.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "<i>$1</i>");
  html = html.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks and inline code
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`\x00CB${i}\x00`, codeBlocks[i]);
  }
  for (let i = 0; i < inlineCodes.length; i++) {
    html = html.replace(`\x00IC${i}\x00`, inlineCodes[i]);
  }

  return html;
}

/**
 * Convert Markdown to Telegram HTML and chunk at the limit.
 */
export function markdownToTelegramHtmlChunks(
  markdown: string,
  limit: number = 4000
): string[] {
  // First chunk the markdown (preserving code blocks)
  const mdChunks = chunkMarkdownAware(markdown, limit);

  // Then convert each chunk to HTML
  return mdChunks.map((chunk) => markdownToTelegramHtml(chunk));
}

// ─── Markdown to Plain Text ──────────────────────────────────────

/**
 * Strip Markdown formatting to produce plain text (for iMessage).
 *
 * Preserves content but removes formatting syntax.
 */
export function markdownToPlainText(markdown: string): string {
  let text = markdown;

  // Remove code block fences (keep content)
  text = text.replace(/```\w*\n?/g, "");

  // Remove bold/italic markers
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/__(.+?)__/g, "$1");
  text = text.replace(/\*(.+?)\*/g, "$1");
  text = text.replace(/_(.+?)_/g, "$1");

  // Remove strikethrough
  text = text.replace(/~~(.+?)~~/g, "$1");

  // Convert links to "text (url)"
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Remove inline code backticks
  text = text.replace(/`([^`]+)`/g, "$1");

  return text;
}

// ─── Format & Chunk for Channel ──────────────────────────────────

/**
 * Format and chunk a message for a specific channel's requirements.
 */
export function formatForChannel(
  text: string,
  options: OutboundFormatOptions
): string[] {
  switch (options.format) {
    case "html":
      return markdownToTelegramHtmlChunks(text, options.maxChunkSize);
    case "plain": {
      const plain = markdownToPlainText(text);
      return chunkText(plain, options.maxChunkSize);
    }
    case "markdown":
      return chunkMarkdownAware(text, options.maxChunkSize);
    default:
      return chunkText(text, options.maxChunkSize);
  }
}

// ─── Utility ─────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
