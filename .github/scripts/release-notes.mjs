/**
 * Assemble one version's release note from CHANGELOG.md.
 *
 * Usage: node .github/scripts/release-notes.mjs <version> <output-file>
 *
 * The CHANGELOG carries a repository-wide `Header` and `Endfix` section, and a
 * version may override either with an H3-level subsection of the same name. The
 * section titles are dropped: the Header content becomes the first line of the
 * note and the Endfix content the last, which is the shape the release template
 * asks for. `**full_changelog!**` is a placeholder, replaced here by a compare
 * link calculated from the version ordering in this same file.
 */

import { readFile, writeFile } from 'node:fs/promises';

const [, , version, outputFile] = process.argv;
if (version === undefined || outputFile === undefined) {
  console.error('usage: release-notes.mjs <version> <output-file>');
  process.exit(2);
}

/** Split a heading line into its level and title, or null when it is not one. */
function heading(line) {
  const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
  return match === null ? null : { level: match[1].length, title: match[2] };
}

/** Drop leading and trailing blank lines. */
function trimBlank(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

const source = await readFile('CHANGELOG.md', 'utf8');
const lines = source.split('\n');

// ── top-level sections ─────────────────────────────────────────────────────
/** @type {Array<{ title: string, lines: string[] }>} */
const sections = [];
let current = null;
for (const line of lines) {
  const mark = heading(line);
  if (mark !== null && mark.level === 2) {
    current = { title: mark.title, lines: [] };
    sections.push(current);
    continue;
  }
  if (current !== null) current.lines.push(line);
}

const findSection = (title) => sections.find((section) => section.title === title);

// ── the requested version ──────────────────────────────────────────────────
const index = sections.findIndex((section) => section.title === version);
if (index === -1) {
  console.error(`CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}

// Newest first, so the next version section below this one is the previous release.
const previous = sections.slice(index + 1).find((section) => /^\d+\.\d+\.\d+/.test(section.title));

/**
 * Pull the H3-level Header/Endfix overrides out of a version section.
 *
 * Every other heading and every body line stays in place, so subsection order
 * in the rendered note keeps matching the order in the file.
 */
function extractOverrides(bodyLines) {
  const overrides = new Map();
  const body = [];
  let capturing = null;
  let buffer = [];
  for (const line of bodyLines) {
    const mark = heading(line);
    if (mark !== null && mark.level === 3 && (mark.title === 'Header' || mark.title === 'Endfix')) {
      if (capturing !== null) overrides.set(capturing, trimBlank(buffer));
      capturing = mark.title;
      buffer = [];
      continue;
    }
    if (capturing !== null) {
      if (mark !== null && mark.level === 3) {
        overrides.set(capturing, trimBlank(buffer));
        capturing = null;
        buffer = [];
        body.push(line);
        continue;
      }
      buffer.push(line);
      continue;
    }
    body.push(line);
  }
  if (capturing !== null) overrides.set(capturing, trimBlank(buffer));
  return { overrides, body: trimBlank(body) };
}

const { overrides, body } = extractOverrides(sections[index].lines);

const header = overrides.get('Header') ?? trimBlank(findSection('Header')?.lines ?? []);
const endfix = overrides.get('Endfix') ?? trimBlank(findSection('Endfix')?.lines ?? []);

// ── the compare link ───────────────────────────────────────────────────────
const repository = process.env.GITHUB_REPOSITORY;
if (repository === undefined) {
  console.error('GITHUB_REPOSITORY is not set');
  process.exit(1);
}

const compare =
  previous === undefined
    ? `https://github.com/${repository}/compare/${version}`
    : `https://github.com/${repository}/compare/${previous.title}...${version}`;

const resolvedEndfix = endfix.map((line) =>
  line.replaceAll('**full_changelog!**', `**Full Changelog**: ${compare}`),
);

// ── assemble ───────────────────────────────────────────────────────────────
const blocks = [
  [`## v${version}`],
  header,
  body,
  resolvedEndfix,
].filter((block) => block.length > 0);

const note = blocks.map((block) => block.join('\n')).join('\n\n') + '\n';
await writeFile(outputFile, note, 'utf8');
console.log(note);
