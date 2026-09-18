import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// sync-claude-commands-to-skills.ts — generate Codex-format SKILL.md files from
// this repo's Claude Code slash-command files (commands/opencode/*.md).
//
// Skill names are derived from --name-prefix (e.g. --name-prefix=opencode turns
// commands/opencode/task.md into the skill "opencode-task") — no hardcoded
// repo prefix. Run with Node >= 22.6 (native TS type stripping; no tsx needed):
//
//   node scripts/sync-claude-commands-to-skills.ts \
//     --name-prefix=opencode
//
// Flags: --source=<dir> (default commands/opencode), --codex (explicit form of
// the default output), --out=<dir> (explicit output dir), --target=repo|system
// (output preset: repo = ./.codex/skills/claude-commands, system =
// ~/.codex/skills/claude-commands; --out wins over --target),
// --name-prefix=<kebab>, --refresh-command=<cmd>.
// Stale skill dirs in the output are pruned.

type ParsedSource = {
  body: string;
  frontmatter: Record<string, string>;
};

export type SyncOptions = {
  namePrefix?: string;
  outputDir: string;
  refreshCommand?: string;
  repoRoot?: string;
  sourceDir: string;
};

const REPO_ROOT = process.cwd();
const DEFAULT_SOURCE_DIR = path.join(REPO_ROOT, "commands", "opencode");

async function main(): Promise<void> {
  if (readFlag("--help") || readFlag("--usage") || readFlag("-?")) {
    printHelp();
    return;
  }
  if (readFlag("--claude")) {
    throw new Error(
      "--claude was removed — this script generates Codex-format skills only; " +
        "use install.sh --claude for the Claude Code install",
    );
  }
  const sourceDir = resolvePathArgument("--source", DEFAULT_SOURCE_DIR);
  const namePrefix = readArgument("--name-prefix");
  const refreshCommand = readArgument("--refresh-command");
  const target = readArgument("--target");
  const outArg = readArgument("--out");

  const outputDir = outArg
    ? path.resolve(REPO_ROOT, outArg)
    : resolveOutputDir(target);

  await syncSkills({
    namePrefix,
    outputDir,
    refreshCommand,
    sourceDir,
  });
}

// --target names the output preset: "repo" = this repository's checkout,
// "system" = the user-wide codex skills dir (~/.codex). An explicit --out
// (resolved in main) still overrides the preset. --codex is accepted as the
// explicit form of the (only) output.
function resolveOutputDir(target: string | undefined): string {
  const base = target === "system" ? os.homedir() : REPO_ROOT;
  return path.join(base, ".codex", "skills", "claude-commands");
}

export async function syncSkills(options: SyncOptions): Promise<void> {
  const { namePrefix, outputDir, refreshCommand, sourceDir } = options;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  validateNamePrefix(namePrefix);
  const sourceFiles = await listMarkdownFiles(sourceDir);
  const commands = sourceFiles.map((sourceFile) => {
    const relativeCommandPath = path.relative(sourceDir, sourceFile);
    return {
      commandLabel: buildCommandLabel(relativeCommandPath, namePrefix),
      commandName: buildCommandName(relativeCommandPath, namePrefix),
      relativeCommandPath,
      sourceFile,
    };
  });

  assertUniqueCommandNames(commands);
  await fs.mkdir(outputDir, { recursive: true });

  let generatedCount = 0;
  for (const command of commands) {
    const { commandLabel, commandName, sourceFile } = command;
    const sourceText = await fs.readFile(sourceFile, "utf8");
    const parsed = parseSource(sourceText);
    const skillDir = path.join(outputDir, commandName);
    const skillPath = path.join(skillDir, "SKILL.md");
    const skillText = renderCodexSkill({
      body: parsed.body,
      commandLabel,
      commandName,
      frontmatter: parsed.frontmatter,
      refreshCommand:
        refreshCommand ?? "node scripts/sync-claude-commands-to-skills.ts",
    });

    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillPath, skillText, "utf8");
    generatedCount += 1;

    console.log(
      `Generated ${normalizePath(path.relative(repoRoot, skillPath))}`,
    );
  }

  const expectedDirs = new Set(
    commands.map(({ commandName }) => commandName),
  );
  const prunedCount = await pruneStaleSkillDirs(
    outputDir,
    expectedDirs,
    repoRoot,
  );

  console.log(
    `Done. Generated ${generatedCount} skills in ${normalizePath(path.relative(repoRoot, outputDir))}.`,
  );
  if (prunedCount > 0) {
    console.log(`Pruned ${prunedCount} stale skill directories.`);
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new Error(
      `Source directory not found: ${dir}\n` +
        `  Pass --source=<path> pointing at the directory containing the Claude ` +
        `command .md files (e.g. --source=commands/opencode), and run this from the ` +
        `skill repo root (node scripts/sync-claude-commands-to-skills.ts).`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`Source path is not a directory: ${dir}`);
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(entryPath);
      if (entry.isFile() && entry.name.endsWith(".md")) return [entryPath];
      return [];
    }),
  );
  return files.flat().sort((a, b) => a.localeCompare(b));
}

function parseSource(content: string): ParsedSource {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatterMatch) {
    return { body: content.trim(), frontmatter: {} };
  }

  const frontmatterBlock = frontmatterMatch[1];
  const rawBody = content.slice(frontmatterMatch[0].length);
  return {
    body: rawBody.trim(),
    frontmatter: parseSimpleFrontmatter(frontmatterBlock),
  };
}

function parseSimpleFrontmatter(
  frontmatterBlock: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of frontmatterBlock.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;

    result[key] = value;
  }
  return result;
}

type RenderSkillInput = {
  body: string;
  commandLabel: string;
  commandName: string;
  frontmatter: Record<string, string>;
  refreshCommand: string;
};

export function renderCodexSkill(input: RenderSkillInput): string {
  const { body, commandLabel, commandName, frontmatter, refreshCommand } =
    input;
  // Skill name = the command name, which already carries --name-prefix
  // (e.g. "opencode-task"); no hardcoded repo prefix.
  const skillName = commandName;
  const description = buildDescription(commandLabel, body);
  const allowedTools = frontmatter["allowed-tools"];
  const title = toTitle(commandName);

  const lines = [
    ...renderSkillFrontmatter({ description, skillName }),
    ...renderSkillBodyHeader({ allowedTools, commandLabel, refreshCommand, title }),
    "",
    "## Codex Adaptation",
    "",
    "- Substitute the user's command arguments for `$ARGUMENTS`; do not treat it as a shell environment variable.",
    "- Interpret Claude-specific tool names and execution flags as intent, then use the equivalent available Codex tools.",
    "",
    "## Workflow",
    "",
    body.trim(),
    "",
  ];
  return lines.join("\n");
}

function renderSkillFrontmatter(input: {
  description: string;
  skillName: string;
}): string[] {
  const { description, skillName } = input;
  return [
    "---",
    `name: "${escapeDoubleQuotes(skillName)}"`,
    `description: "${escapeDoubleQuotes(description)}"`,
    "---",
  ];
}

function renderSkillBodyHeader(input: {
  allowedTools: string | undefined;
  commandLabel: string;
  refreshCommand: string;
  title: string;
}): string[] {
  const { allowedTools, commandLabel, refreshCommand, title } = input;
  const lines = [
    "",
    `# ${title}`,
    "",
    `Re-run \`${refreshCommand}\` to refresh this file from source.`,
    "",
    "## Trigger",
    "",
    `Use this skill when the user asks to run the \`/${commandLabel}\` command workflow for this repository.`,
  ];
  if (allowedTools) {
    lines.push(
      "",
      "## Allowed Tools From Source",
      "",
      `Source frontmatter \`allowed-tools\`: \`${allowedTools}\``,
    );
  }
  return lines;
}

function buildDescription(commandLabel: string, body: string): string {
  const firstBodySentence = firstSentence(body);
  if (firstBodySentence) {
    return `Use when the user asks for the "/${commandLabel}" workflow. ${firstBodySentence}`;
  }
  return `Use when the user asks for the "/${commandLabel}" workflow from this repository's maintenance commands.`;
}

function firstSentence(markdown: string): string | null {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith("#") && !line.startsWith("```"),
    );

  if (lines.length === 0) return null;

  const candidate = lines[0]
    .replace(/[`*_]/g, "")
    .replace(/</g, "[")
    .replace(/>/g, "]");
  return candidate.length > 180 ? `${candidate.slice(0, 177)}...` : candidate;
}

function toTitle(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function readArgument(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function readFlag(name: string): boolean {
  return process.argv.includes(name);
}

function printHelp(): void {
  console.log(`Usage: node scripts/sync-claude-commands-to-skills.ts [options]

Generate Codex-format SKILL.md files from this repo's Claude Code slash-command
files (commands/opencode/*.md).

Options:
  --codex                   Explicit form of the default output: Codex-format
                            skills (./.codex/skills/claude-commands, or
                            ~/.codex/skills/claude-commands with
                            --target=system).
  --out=<dir>               Explicit output directory (overrides --target).
  --target=repo|system      Output preset: repo = this repository's checkout,
                            system = the user-wide codex skills directory
                            (~/.codex). Default: repo.
  --source=<dir>            Directory containing the Claude command .md files.
                            Default: commands/opencode.
  --name-prefix=<kebab>     Prefix for generated skill names, e.g. opencode
                            turns task.md into the skill opencode-task.
                            Default: none (bare command names).
  --refresh-command=<cmd>   Command shown in each generated skill for
                            regenerating it from source. Default: node
                            scripts/sync-claude-commands-to-skills.ts.
  --help, --usage, -?       Show this help and exit.

Notes:
  - Requires Node >= 22.6 (native TypeScript type stripping; no tsx needed).
  - --claude was removed: this script emits Codex skills only; use
    install.sh --claude for the Claude Code install.
  - Stale skill directories in the output are pruned.
  - Example:
      node scripts/sync-claude-commands-to-skills.ts \\
        --name-prefix=opencode
`);
}

function resolvePathArgument(name: string, fallback: string): string {
  const value = readArgument(name);
  return value ? path.resolve(REPO_ROOT, value) : fallback;
}

function validateNamePrefix(namePrefix: string | undefined): void {
  if (namePrefix && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(namePrefix)) {
    throw new Error(`Invalid --name-prefix: ${namePrefix}`);
  }
}

function buildCommandName(
  relativeCommandPath: string,
  namePrefix: string | undefined,
): string {
  const pathParts = commandPathParts(relativeCommandPath);
  return [...(namePrefix ? [namePrefix] : []), ...pathParts].join("-");
}

function buildCommandLabel(
  relativeCommandPath: string,
  namePrefix: string | undefined,
): string {
  return [
    ...(namePrefix ? [namePrefix] : []),
    ...commandPathParts(relativeCommandPath),
  ].join(":");
}

function commandPathParts(relativeCommandPath: string): string[] {
  const pathWithoutExtension = relativeCommandPath.slice(
    0,
    -path.extname(relativeCommandPath).length,
  );
  return pathWithoutExtension.split(path.sep).map(toSkillNamePart);
}

function assertUniqueCommandNames(
  commands: Array<{ commandName: string; sourceFile: string }>,
): void {
  const sourcesByName = new Map<string, string>();
  for (const { commandName, sourceFile } of commands) {
    const existingSource = sourcesByName.get(commandName);
    if (existingSource) {
      throw new Error(
        `Command name collision for ${commandName}: ${existingSource}, ${sourceFile}`,
      );
    }
    sourcesByName.set(commandName, sourceFile);
  }
}

function toSkillNamePart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error(`Cannot derive a skill name from ${value}`);
  return normalized;
}

async function pruneStaleSkillDirs(
  outputDir: string,
  expectedDirs: Set<string>,
  repoRoot: string,
): Promise<number> {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (expectedDirs.has(entry.name)) continue;

    const stalePath = path.join(outputDir, entry.name);
    await fs.rm(stalePath, { recursive: true, force: true });
    removed += 1;
    console.log(`Pruned ${normalizePath(path.relative(repoRoot, stalePath))}`);
  }
  return removed;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
