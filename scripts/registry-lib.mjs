import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

const registryRef = "v0.2.0"
const registryItems = ["aggregate", "check-rules", "match-tag"]

const root = path.resolve(import.meta.dirname, "..")
const itemAddresses = registryItems.map((item) => `timzolleis/effect-ddd/${item}#${registryRef}`)
const runShadcn = (args) =>
  execFileSync("npx", ["--yes", "shadcn@latest", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })

const installRegistryLib = () => {
  process.stdout.write(runShadcn(["add", ...itemAddresses, "--overwrite", "--yes"]))
}

const checkRegistryLib = () => {
  const viewOutput = runShadcn(["view", ...itemAddresses])
  const registryItemPayloads = JSON.parse(viewOutput.slice(viewOutput.indexOf("[")))
  const differingFiles = registryItemPayloads.flatMap((item) => item.files
    .map((file) => ({ localPath: file.target.replace(/^~\//, ""), registryContent: file.content }))
    .filter(({ localPath, registryContent }) => readFileSync(path.join(root, localPath), "utf8") !== registryContent)
    .map(({ localPath }) => localPath))
  if (differingFiles.length > 0) {
    console.error(`registry-lib: differs from timzolleis/effect-ddd#${registryRef}: ${differingFiles.join(", ")}`)
    console.error("Change the helper in timzolleis/effect-ddd, then run npm run lib:install with the new ref.")
    process.exit(1)
  }
  console.log(`registry-lib: ${registryItemPayloads.length} helpers match timzolleis/effect-ddd#${registryRef}`)
}

const mode = process.argv[2]
if (mode === "install") installRegistryLib()
else if (mode === "check") checkRegistryLib()
else {
  console.error("usage: node scripts/registry-lib.mjs install | check")
  process.exit(1)
}
