// Checks that every ```ts / ```prisma block in the given docs is an excerpt of this code.
// Usage: node scripts/check-doc-excerpts.mjs [file.md | dir]...   (default: SPEC.md; a dir means its *.md)
//
// Rules for a block:
// - First line `// <path>`: the file, relative to src/ (or prisma/…, test/…). Its other lines must appear
//   in that file, in order (whitespace-insensitive). Blank lines and lines containing `…` (elision) are skipped.
// - First line `// not in the example code: <why>` or `// variant: <why>`: an alternative, not checked; listed in the report.
// - Anything else fails.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const args = process.argv.slice(2).map((arg) => arg.replace(/^~(?=\/)/, os.homedir()))
const docPaths = (args.length > 0 ? args : [path.join(root, "SPEC.md")]).flatMap((arg) =>
  statSync(arg).isDirectory()
    ? readdirSync(arg).filter((name) => name.endsWith(".md")).sort().map((name) => path.join(arg, name))
    : [arg])

const normalize = (line) => line.replace(/\s+/g, " ").trim()
const blocks = docPaths.flatMap((docPath) => {
  // Blanked, not removed, so line numbers stay right: code inside a ~~~ fence is an example of a doc, not of this code.
  const doc = readFileSync(docPath, "utf8").replace(/^~~~[\s\S]*?^~~~/gm, (fence) => fence.replace(/[^\n]/g, " "))
  return [...doc.matchAll(/^```(ts|prisma)\n([\s\S]*?)^```/gm)].map((match) => ({
    language: match[1],
    lines: match[2].replace(/\n$/, "").split("\n"),
    where: `${path.basename(docPath)}:${doc.slice(0, match.index).split("\n").length}`,
  }))
})

const failures = []
const unchecked = []
let checkedLines = 0

for (const block of blocks) {
  const [header, ...body] = block.lines
  const { where } = block
  const pathMatch = /^\/\/ ([\w./-]+\.(?:ts|prisma))$/.exec(header ?? "")
  if (header?.startsWith("// not in the example code:") || header?.startsWith("// variant:")) {
    unchecked.push(`${where}: ${header.slice(3)}`)
    continue
  }
  if (!pathMatch) {
    failures.push(`${where}: first line must be "// <path>", "// not in the example code: <why>", or "// variant: <why>", got: ${header}`)
    continue
  }
  const relativePath = pathMatch[1]
  const filePath = /^(prisma|test)\//.test(relativePath) ? path.join(root, relativePath) : path.join(root, "src", relativePath)
  if (!existsSync(filePath)) {
    failures.push(`${where}: no such file ${relativePath}`)
    continue
  }
  const fileLines = readFileSync(filePath, "utf8").split("\n").map(normalize)
  let cursor = 0
  for (const [offset, line] of body.entries()) {
    const wanted = normalize(line)
    if (wanted === "" || wanted.includes("…")) continue
    const found = fileLines.indexOf(wanted, cursor)
    if (found === -1) {
      const anywhere = fileLines.indexOf(wanted)
      failures.push(`${where} + ${offset + 1} (${relativePath}): ${anywhere === -1 ? "not in file" : "out of order"}: ${line.trim()}`)
      continue
    }
    cursor = found + 1
    checkedLines++
  }
}

console.log(`${blocks.length} blocks, ${checkedLines} lines matched, ${unchecked.length} unchecked`)
for (const line of unchecked) console.log(`  unchecked ${line}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} mismatches:`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
