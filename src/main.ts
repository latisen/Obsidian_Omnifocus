import { execFile } from "node:child_process";
import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";

interface ExportRecord {
  fingerprint: string;
  createdAt: string;
  sourcePath: string;
  sourceLine?: number;
  title: string;
  note: string;
}

interface ParsedObsidianTask {
  title: string;
  note: string;
  sourcePath: string;
  sourceLine: number;
  headingPath: string[];
  rawTaskLine: string;
  children: ParsedObsidianTask[];
}

interface PreparedOmniFocusTask {
  title: string;
  note: string;
  backlinkUrl: string;
  backlinkLabel: string;
  sourcePath: string;
  sourceLine: number;
  headingPath: string[];
  fingerprint: string;
  children: PreparedOmniFocusTask[];
}

interface DedupeSummary {
  totalPrepared: number;
  uniqueTasks: PreparedOmniFocusTask[];
  duplicateInScanCount: number;
  alreadyExportedTasks: PreparedOmniFocusTask[];
  pendingExportTasks: PreparedOmniFocusTask[];
}

interface SyncSummary {
  dedupeSummary: DedupeSummary;
  createdTasks: PreparedOmniFocusTask[];
  failedTasks: PreparedOmniFocusTask[];
  dryRun: boolean;
  errorMessage?: string;
  firstFailureMessage?: string;
}

interface OmniFocusExportResult {
  ok: boolean;
  errorMessage?: string;
}

interface OmniFocusPluginState {
  exportedTasks: Record<string, ExportRecord>;
}

interface OmniFocusPluginSettings {
  vaultName: string;
  excludedFolders: string;
  dryRun: boolean;
}

interface StoredPluginData {
  settings?: Partial<OmniFocusPluginSettings>;
  state?: {
    exportedTasks?: Record<string, ExportRecord>;
  };
}

const DEFAULT_SETTINGS: OmniFocusPluginSettings = {
  vaultName: "",
  excludedFolders: "",
  dryRun: true
};

const DEFAULT_STATE: OmniFocusPluginState = {
  exportedTasks: {}
};

const TASK_LINE_PATTERN = /^([ \t]*)([-*+]\s+\[(.)\]\s+)(.+)$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.*\S)\s*$/;
const FINGERPRINT_VERSION = "v1";

export default class ObsidianOmniFocusPlugin extends Plugin {
  override settings: OmniFocusPluginSettings = { ...DEFAULT_SETTINGS };
  state: OmniFocusPluginState = {
    exportedTasks: {}
  };

  override async onload(): Promise<void> {
    await this.loadPluginData();

    this.addCommand({
      id: "sync-unfinished-tasks-to-omnifocus",
      name: "Sync unfinished tasks to OmniFocus Inbox",
      callback: async () => {
        const syncSummary = await this.syncTasksToOmniFocus();
        new Notice(this.createSyncNotice(syncSummary), 9000);
      }
    });

    this.addCommand({
      id: "clear-exported-task-cache",
      name: "Clear exported task cache",
      callback: async () => {
        await this.clearExportedTaskCache();
        new Notice("Exported task cache cleared.");
      }
    });

    this.addCommand({
      id: "test-omnifocus-applescript-bridge",
      name: "Test OmniFocus AppleScript bridge",
      callback: async () => {
        const result = await this.testOmniFocusAppleScriptBridge();
        new Notice(result.ok ? "OmniFocus AppleScript bridge is working." : `OmniFocus AppleScript bridge failed: ${result.errorMessage ?? "Unknown error."}` , 10000);
      }
    });

    this.addSettingTab(new OmniFocusSettingTab(this.app, this));
  }

  getExcludedFolders(): string[] {
    return this.settings.excludedFolders
      .split(/\r?\n|,/) 
      .map((value) => value.trim())
      .filter(Boolean);
  }

  hasExportRecord(fingerprint: string): boolean {
    return fingerprint in this.state.exportedTasks;
  }

  getExportRecord(fingerprint: string): ExportRecord | null {
    return this.state.exportedTasks[fingerprint] ?? null;
  }

  createTaskFingerprint(task: ParsedObsidianTask): string {
    const heading = normalizeFingerprintValue(task.headingPath.join(" > "));
    const stableReference = normalizeFingerprintValue(`${task.sourceLine}`);
    const childSignature = task.children.map((child) => serializeParsedTaskForFingerprint(child)).join("||");
    return [
      FINGERPRINT_VERSION,
      normalizeFingerprintValue(task.sourcePath),
      stableReference,
      heading,
      normalizeFingerprintValue(task.title),
      normalizeFingerprintValue(task.note),
      childSignature
    ].join("::");
  }

  prepareTaskForOmniFocus(task: ParsedObsidianTask): PreparedOmniFocusTask {
    const backlinkUrl = this.createObsidianBacklink(task);
    const backlinkLabel = this.createBacklinkLabel(task);
    const note = this.buildOmniFocusNote(task.note, backlinkLabel, backlinkUrl);

    return {
      title: task.title,
      note,
      backlinkUrl,
      backlinkLabel,
      sourcePath: task.sourcePath,
      sourceLine: task.sourceLine,
      headingPath: [...task.headingPath],
      fingerprint: this.createTaskFingerprint(task),
      children: task.children.map((child) => this.prepareTaskForOmniFocus(child))
    };
  }

  buildDedupeSummary(tasks: PreparedOmniFocusTask[]): DedupeSummary {
    const uniqueTasks: PreparedOmniFocusTask[] = [];
    const seenFingerprints = new Set<string>();
    let duplicateInScanCount = 0;

    for (const task of tasks) {
      if (seenFingerprints.has(task.fingerprint)) {
        duplicateInScanCount += 1;
        continue;
      }

      seenFingerprints.add(task.fingerprint);
      uniqueTasks.push(task);
    }

    const alreadyExportedTasks = uniqueTasks.filter((task) => this.hasExportRecord(task.fingerprint));
    const pendingExportTasks = uniqueTasks.filter((task) => !this.hasExportRecord(task.fingerprint));

    return {
      totalPrepared: tasks.length,
      uniqueTasks,
      duplicateInScanCount,
      alreadyExportedTasks,
      pendingExportTasks
    };
  }

  async syncTasksToOmniFocus(): Promise<SyncSummary> {
    const parsedTasks = await this.collectUnfinishedTasks();
    const preparedTasks = parsedTasks.map((task) => this.prepareTaskForOmniFocus(task));
    const dedupeSummary = this.buildDedupeSummary(preparedTasks);

    if (this.settings.dryRun) {
      return {
        dedupeSummary,
        createdTasks: [],
        failedTasks: [],
        dryRun: true
      };
    }

    const runtimeValidationError = this.validateOmniFocusRuntime();
    if (runtimeValidationError) {
      return {
        dedupeSummary,
        createdTasks: [],
        failedTasks: dedupeSummary.pendingExportTasks,
        dryRun: false,
        errorMessage: runtimeValidationError
      };
    }

    if (dedupeSummary.pendingExportTasks.length === 0) {
      return {
        dedupeSummary,
        createdTasks: [],
        failedTasks: [],
        dryRun: false
      };
    }

    const createdTasks: PreparedOmniFocusTask[] = [];
    const failedTasks: PreparedOmniFocusTask[] = [];
    let firstFailureMessage: string | undefined;

    for (const task of dedupeSummary.pendingExportTasks) {
      const exported = await this.exportTaskToOmniFocus(task);
      if (!exported.ok) {
        failedTasks.push(task);
        firstFailureMessage ??= exported.errorMessage;
        continue;
      }

      await this.rememberExport(task);
      createdTasks.push(task);
    }

    return {
      dedupeSummary,
      createdTasks,
      failedTasks,
      dryRun: false,
      firstFailureMessage
    };
  }

  async collectUnfinishedTasks(): Promise<ParsedObsidianTask[]> {
    const markdownFiles = this.app.vault
      .getMarkdownFiles()
      .filter((file) => !this.isExcludedPath(file.path));

    const parsedTaskLists = await Promise.all(markdownFiles.map(async (file) => this.parseTasksFromFile(file)));
    return parsedTaskLists.flat();
  }

  isExcludedPath(path: string): boolean {
    const normalizedPath = path.toLowerCase();
    return this.getExcludedFolders().some((folder) => {
      const normalizedFolder = folder.replace(/^\/+|\/+$/g, "").toLowerCase();
      return normalizedFolder.length > 0 && (normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`));
    });
  }

  async parseTasksFromFile(file: TFile): Promise<ParsedObsidianTask[]> {
    const content = await this.app.vault.cachedRead(file);
    return parseMarkdownTasks(content, file.path);
  }

  createObsidianBacklink(task: ParsedObsidianTask): string {
    const vaultName = this.settings.vaultName.trim() || this.app.vault.getName();
    return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(task.sourcePath)}`;
  }

  createBacklinkLabel(task: ParsedObsidianTask): string {
    const headingSuffix = task.headingPath.length > 0 ? ` > ${task.headingPath.join(" > ")}` : "";
    return `${task.sourcePath}${headingSuffix} (line ${task.sourceLine})`;
  }

  buildOmniFocusNote(noteBody: string, backlinkLabel: string, backlinkUrl: string): string {
    const sections = [noteBody.trim(), `Obsidian: ${backlinkLabel}\n${backlinkUrl}`].filter((value) => value.length > 0);
    return sections.join("\n\n");
  }

  validateOmniFocusRuntime(): string | null {
    if (!Platform.isDesktopApp) {
      return "OmniFocus sync requires Obsidian Desktop.";
    }

    if (!Platform.isMacOS) {
      return "OmniFocus sync requires macOS with OmniFocus installed.";
    }

    if (typeof process === "undefined") {
      return "This environment cannot run AppleScript for OmniFocus export.";
    }

    return null;
  }

  async exportTaskToOmniFocus(task: PreparedOmniFocusTask): Promise<OmniFocusExportResult> {
    try {
      await runOmniFocusAppleScript(task);
      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown AppleScript error.";
      console.error("Failed to create OmniFocus task via AppleScript", { error, task });
      return {
        ok: false,
        errorMessage
      };
    }
  }

  async testOmniFocusAppleScriptBridge(): Promise<OmniFocusExportResult> {
    const runtimeValidationError = this.validateOmniFocusRuntime();
    if (runtimeValidationError) {
      return {
        ok: false,
        errorMessage: runtimeValidationError
      };
    }

    try {
      await runAppleScript([
        "tell application \"OmniFocus\"",
        "tell default document",
        "name",
        "end tell",
        "end tell"
      ].join("\n"));

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        errorMessage: error instanceof Error ? error.message : "Unknown AppleScript bridge error."
      };
    }
  }

  createSyncNotice(summary: SyncSummary): string {
    const { dedupeSummary } = summary;

    if (summary.dryRun) {
      return `Dry run: prepared ${dedupeSummary.totalPrepared} tasks, ${dedupeSummary.pendingExportTasks.length} pending export, ${dedupeSummary.alreadyExportedTasks.length} already recorded, ${dedupeSummary.duplicateInScanCount} duplicate(s) in this scan.`;
    }

    if (summary.errorMessage) {
      return `${summary.errorMessage} Prepared ${dedupeSummary.totalPrepared} tasks, but no export was performed.`;
    }

    if (dedupeSummary.pendingExportTasks.length === 0) {
      return `Sync complete: no new tasks to export. Skipped ${dedupeSummary.alreadyExportedTasks.length}, duplicate(s) in scan ${dedupeSummary.duplicateInScanCount}.`;
    }

    if (summary.failedTasks.length > 0 && summary.firstFailureMessage) {
      return `Sync complete: created ${summary.createdTasks.length}, skipped ${dedupeSummary.alreadyExportedTasks.length}, failed ${summary.failedTasks.length}. First error: ${summary.firstFailureMessage}`;
    }

    return `Sync complete: created ${summary.createdTasks.length}, skipped ${dedupeSummary.alreadyExportedTasks.length}, failed ${summary.failedTasks.length}, duplicate(s) in scan ${dedupeSummary.duplicateInScanCount}.`;
  }

  createExportRecord(task: PreparedOmniFocusTask): ExportRecord {
    return {
      fingerprint: task.fingerprint,
      createdAt: new Date().toISOString(),
      sourcePath: task.sourcePath,
      sourceLine: task.sourceLine,
      title: task.title,
      note: task.note
    };
  }

  async rememberExport(record: ExportRecord | PreparedOmniFocusTask): Promise<void> {
    const normalizedRecord = "backlinkUrl" in record ? this.createExportRecord(record) : record;
    this.state.exportedTasks[normalizedRecord.fingerprint] = normalizedRecord;
    await this.savePluginData();
  }

  async clearExportedTaskCache(): Promise<void> {
    this.state.exportedTasks = {};
    await this.savePluginData();
  }

  private async loadPluginData(): Promise<void> {
    const storedData = (await this.loadData()) as StoredPluginData | null;
    const storedSettings = storedData?.settings ?? {};
    const storedState = storedData?.state?.exportedTasks ?? {};

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...storedSettings,
      vaultName: storedSettings.vaultName?.trim() || this.app.vault.getName()
    };

    this.state = {
      ...DEFAULT_STATE,
      exportedTasks: { ...storedState }
    };

    await this.savePluginData();
  }

  async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      state: this.state
    });
  }
}

function parseMarkdownTasks(content: string, sourcePath: string): ParsedObsidianTask[] {
  const lines = content.split(/\r?\n/);
  const tasks: ParsedObsidianTask[] = [];
  const headingPath: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headingMatch = line.match(HEADING_PATTERN);

    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      headingPath.length = level - 1;
      headingPath[level - 1] = headingText;
      continue;
    }

    const taskMatch = line.match(TASK_LINE_PATTERN);
    if (!taskMatch) {
      continue;
    }

    if (isCompletedTask(taskMatch[3]) || taskMatch[4].trim().length === 0) {
      continue;
    }

    const parsedTask = parseTaskTree(lines, index, sourcePath, [...headingPath]);
    if (!parsedTask) {
      continue;
    }

    tasks.push(parsedTask.task);
    index = parsedTask.nextIndex - 1;
  }

  return tasks;
}

function parseTaskTree(
  lines: string[],
  startIndex: number,
  sourcePath: string,
  headingPath: string[]
): { task: ParsedObsidianTask; nextIndex: number } | null {
  const line = lines[startIndex];
  const taskMatch = line.match(TASK_LINE_PATTERN);
  if (!taskMatch) {
    return null;
  }

  const indent = taskMatch[1];
  const status = taskMatch[3];
  const title = taskMatch[4].trim();
  const currentIndentLength = getIndentWidth(indent);

  if (isCompletedTask(status) || title.length === 0) {
    return null;
  }

  const noteLines: string[] = [];
  const children: ParsedObsidianTask[] = [];
  let nextIndex = startIndex + 1;

  while (nextIndex < lines.length) {
    const candidateLine = lines[nextIndex];

    if (candidateLine.trim().length === 0) {
      noteLines.push("");
      nextIndex += 1;
      continue;
    }

    const candidateTaskMatch = candidateLine.match(TASK_LINE_PATTERN);
    if (candidateTaskMatch) {
      const candidateIndentLength = getIndentWidth(candidateTaskMatch[1]);
      if (candidateIndentLength <= currentIndentLength) {
        break;
      }

      if (isCompletedTask(candidateTaskMatch[3]) || candidateTaskMatch[4].trim().length === 0) {
        nextIndex += 1;
        continue;
      }

      const parsedChildTask = parseTaskTree(lines, nextIndex, sourcePath, headingPath);
      if (!parsedChildTask) {
        nextIndex += 1;
        continue;
      }

      children.push(parsedChildTask.task);
      nextIndex = parsedChildTask.nextIndex;
      continue;
    }

    const continuationIndentLength = getIndentWidth(candidateLine.match(/^([ \t]*)/)?.[1] ?? "");
    const minimumChildIndent = currentIndentLength + 1;
    if (continuationIndentLength < minimumChildIndent) {
      break;
    }

    noteLines.push(stripContinuationIndent(candidateLine, minimumChildIndent));
    nextIndex += 1;
  }

  while (noteLines.length > 0 && noteLines[noteLines.length - 1] === "") {
    noteLines.pop();
  }

  return {
    task: {
      title,
      note: noteLines.join("\n"),
      sourcePath,
      sourceLine: startIndex + 1,
      headingPath,
      rawTaskLine: line,
      children
    },
    nextIndex
  };
}

function isCompletedTask(status: string): boolean {
  return status.trim().toLowerCase() === "x";
}

function normalizeFingerprintValue(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

async function runAppleScript(script: string, args: string[] = []): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("osascript", ["-e", script, "--", ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }

      resolve();
    });
  });
}

async function runOmniFocusAppleScript(task: PreparedOmniFocusTask): Promise<void> {
  const script = buildOmniFocusAppleScript(task);
  await runAppleScript(script);
}

function buildOmniFocusAppleScript(task: PreparedOmniFocusTask): string {
  const lines = [
    "tell application \"OmniFocus\"",
    "  tell default document"
  ];

  appendTaskCreationLines(lines, task, "rootTask", 2, null);
  lines.push("  end tell", "end tell");

  return lines.join("\n");
}

function appendTaskCreationLines(
  lines: string[],
  task: PreparedOmniFocusTask,
  variableName: string,
  indentLevel: number,
  parentVariableName: string | null
): void {
  const indent = "  ".repeat(indentLevel);
  const properties = `{name:${toAppleScriptString(task.title)}, note:${toAppleScriptString(task.note)}}`;

  if (parentVariableName === null) {
    lines.push(`${indent}set ${variableName} to make new inbox task with properties ${properties}`);
  } else {
    lines.push(`${indent}set ${variableName} to make new task with properties ${properties} at end of tasks of ${parentVariableName}`);
  }

  task.children.forEach((child, index) => {
    appendTaskCreationLines(lines, child, `${variableName}_${index + 1}`, indentLevel, variableName);
  });
}

function toAppleScriptString(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  return value
    .split("\n")
    .map((part) => `"${escapeAppleScriptString(part)}"`)
    .join(" & linefeed & ");
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function serializeParsedTaskForFingerprint(task: ParsedObsidianTask): string {
  const childSignature = task.children.map((child) => serializeParsedTaskForFingerprint(child)).join("||");
  return [
    normalizeFingerprintValue(task.title),
    normalizeFingerprintValue(task.note),
    normalizeFingerprintValue(task.sourcePath),
    normalizeFingerprintValue(`${task.sourceLine}`),
    normalizeFingerprintValue(task.headingPath.join(" > ")),
    childSignature
  ].join("::");
}

function getIndentWidth(input: string): number {
  return input.replace(/\t/g, "    ").length;
}

function stripContinuationIndent(line: string, minimumChildIndent: number): string {
  let visualWidth = 0;
  let cutIndex = 0;

  while (cutIndex < line.length && visualWidth < minimumChildIndent) {
    const char = line[cutIndex];
    if (char === " ") {
      visualWidth += 1;
      cutIndex += 1;
      continue;
    }

    if (char === "\t") {
      visualWidth += 4;
      cutIndex += 1;
      continue;
    }

    break;
  }

  return line.slice(cutIndex);
}

class OmniFocusSettingTab extends PluginSettingTab {
  plugin: ObsidianOmniFocusPlugin;

  constructor(app: App, plugin: ObsidianOmniFocusPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian OmniFocus settings" });

    new Setting(containerEl)
      .setName("Vault name")
      .setDesc("Used when generating Obsidian backlinks.")
      .addText((text) => {
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(this.plugin.settings.vaultName)
          .onChange(async (value) => {
            this.plugin.settings.vaultName = value.trim() || this.app.vault.getName();
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Comma-separated or one folder per line. These folders will be skipped during sync.")
      .addTextArea((text) => {
        text
          .setPlaceholder("Templates, Archive/Meetings")
          .setValue(this.plugin.settings.excludedFolders)
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value;
            await this.plugin.savePluginData();
          });

        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
      });

    new Setting(containerEl)
      .setName("Dry run")
      .setDesc("Prepare sync results without sending tasks to OmniFocus.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.dryRun).onChange(async (value) => {
          this.plugin.settings.dryRun = value;
          await this.plugin.savePluginData();
        });
      });
  }
}