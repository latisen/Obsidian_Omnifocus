import { execFile } from "node:child_process";
import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";

interface ExportRecord {
  fingerprint: string;
  createdAt: string;
  sourcePath: string;
  sourceLine?: number;
  title: string;
  note: string;
  omniFocusId?: string;
}

interface ParsedObsidianTask {
  title: string;
  note: string;
  completed: boolean;
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
  duplicateInScanTasks: PreparedOmniFocusTask[];
  alreadyExportedTasks: PreparedOmniFocusTask[];
  pendingExportTasks: PreparedOmniFocusTask[];
}

interface SyncIssue {
  title: string;
  sourcePath: string;
  sourceLine: number;
  reason: string;
}

interface SyncSummary {
  dedupeSummary: DedupeSummary;
  createdTasks: PreparedOmniFocusTask[];
  failedTasks: PreparedOmniFocusTask[];
  dryRun: boolean;
  issueCount: number;
  issueReportPath?: string;
  errorMessage?: string;
  firstFailureMessage?: string;
}

interface OmniFocusExportResult {
  ok: boolean;
  errorMessage?: string;
  omniFocusId?: string;
}

interface OmniFocusTaskStatus {
  id: string;
  completed: boolean;
  missing: boolean;
}

interface CompletionSyncSummary {
  compared: number;
  updatedInObsidian: number;
  updatedInOmniFocus: number;
  missingInOmniFocus: number;
  missingInObsidian: number;
  failedUpdates: number;
  firstFailureMessage?: string;
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
      id: "reset-sync-state-and-export-all",
      name: "Reset sync state and export all unfinished tasks",
      callback: async () => {
        await this.clearExportedTaskCache();
        const syncSummary = await this.syncTasksToOmniFocus();
        new Notice(`Sync cache reset. ${this.createSyncNotice(syncSummary)}`, 12000);
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

    this.addCommand({
      id: "sync-completed-state-bidirectional",
      name: "Sync completed state between Obsidian and OmniFocus",
      callback: async () => {
        const summary = await this.syncCompletionStateBidirectional();
        new Notice(this.createCompletionSyncNotice(summary), 10000);
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
    const duplicateInScanTasks: PreparedOmniFocusTask[] = [];

    for (const task of tasks) {
      if (seenFingerprints.has(task.fingerprint)) {
        duplicateInScanCount += 1;
        duplicateInScanTasks.push(task);
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
      duplicateInScanTasks,
      alreadyExportedTasks,
      pendingExportTasks
    };
  }

  async syncTasksToOmniFocus(): Promise<SyncSummary> {
    const parsedTasks = await this.collectUnfinishedTasks();
    const preparedTasks = parsedTasks.map((task) => this.prepareTaskForOmniFocus(task));
    const dedupeSummary = this.buildDedupeSummary(preparedTasks);
    const syncIssues: SyncIssue[] = this.createDedupeSyncIssues(dedupeSummary);

    if (this.settings.dryRun) {
      return this.finalizeSyncSummary({
        dedupeSummary,
        createdTasks: [],
        failedTasks: [],
        dryRun: true
      }, syncIssues);
    }

    const runtimeValidationError = this.validateOmniFocusRuntime();
    if (runtimeValidationError) {
      dedupeSummary.pendingExportTasks.forEach((task) => {
        syncIssues.push(this.createSyncIssue(task, `Export failed: ${runtimeValidationError}`));
      });

      return this.finalizeSyncSummary({
        dedupeSummary,
        createdTasks: [],
        failedTasks: dedupeSummary.pendingExportTasks,
        dryRun: false,
        errorMessage: runtimeValidationError
      }, syncIssues);
    }

    if (dedupeSummary.pendingExportTasks.length === 0) {
      return this.finalizeSyncSummary({
        dedupeSummary,
        createdTasks: [],
        failedTasks: [],
        dryRun: false
      }, syncIssues);
    }

    const createdTasks: PreparedOmniFocusTask[] = [];
    const failedTasks: PreparedOmniFocusTask[] = [];
    let firstFailureMessage: string | undefined;

    for (const task of dedupeSummary.pendingExportTasks) {
      const exported = await this.exportTaskToOmniFocus(task);
      if (!exported.ok) {
        failedTasks.push(task);
        firstFailureMessage ??= exported.errorMessage;
        syncIssues.push(this.createSyncIssue(task, `Export failed: ${exported.errorMessage ?? "Unknown AppleScript error."}`));
        continue;
      }

      await this.rememberExport(this.createExportRecord(task, exported.omniFocusId));
      createdTasks.push(task);
    }

    return this.finalizeSyncSummary({
      dedupeSummary,
      createdTasks,
      failedTasks,
      dryRun: false,
      firstFailureMessage
    }, syncIssues);
  }

  createDedupeSyncIssues(dedupeSummary: DedupeSummary): SyncIssue[] {
    const issues: SyncIssue[] = [];

    dedupeSummary.alreadyExportedTasks.forEach((task) => {
      issues.push(this.createSyncIssue(task, "Skipped: already exported (fingerprint exists in cache)."));
    });

    dedupeSummary.duplicateInScanTasks.forEach((task) => {
      issues.push(this.createSyncIssue(task, "Skipped: duplicate task in this scan (same fingerprint)."));
    });

    return issues;
  }

  createSyncIssue(task: PreparedOmniFocusTask, reason: string): SyncIssue {
    return {
      title: task.title,
      sourcePath: task.sourcePath,
      sourceLine: task.sourceLine,
      reason
    };
  }

  async finalizeSyncSummary(
    baseSummary: Omit<SyncSummary, "issueCount" | "issueReportPath">,
    syncIssues: SyncIssue[]
  ): Promise<SyncSummary> {
    const issueReportPath = await this.writeSyncIssuesReport(baseSummary, syncIssues);
    return {
      ...baseSummary,
      issueCount: syncIssues.length,
      issueReportPath
    };
  }

  async writeSyncIssuesReport(baseSummary: Omit<SyncSummary, "issueCount" | "issueReportPath">, syncIssues: SyncIssue[]): Promise<string | undefined> {
    if (syncIssues.length === 0) {
      return undefined;
    }

    const timestamp = new Date();
    const displayTimestamp = timestamp.toISOString();
    const fileName = this.createSyncIssuesFileName(timestamp);
    const filePath = await this.getAvailableRootFilePath(fileName);
    const contentLines = [
      `# Synkerrors ${displayTimestamp}`,
      "",
      `- Dry run: ${baseSummary.dryRun ? "yes" : "no"}`,
      `- Prepared: ${baseSummary.dedupeSummary.totalPrepared}`,
      `- Created: ${baseSummary.createdTasks.length}`,
      `- Failed: ${baseSummary.failedTasks.length}`,
      `- Skipped already exported: ${baseSummary.dedupeSummary.alreadyExportedTasks.length}`,
      `- Duplicates in scan: ${baseSummary.dedupeSummary.duplicateInScanCount}`,
      "",
      "## Tasks skipped or failed",
      ""
    ];

    syncIssues.forEach((issue) => {
      contentLines.push(`- ${issue.sourcePath}:${issue.sourceLine} | ${issue.title} | ${issue.reason}`);
    });

    await this.app.vault.create(filePath, contentLines.join("\n"));
    return filePath;
  }

  createSyncIssuesFileName(timestamp: Date): string {
    const iso = timestamp.toISOString().replace(/[:]/g, "-");
    return `Synkerrors-${iso}.md`;
  }

  async getAvailableRootFilePath(initialPath: string): Promise<string> {
    if (!this.app.vault.getAbstractFileByPath(initialPath)) {
      return initialPath;
    }

    const extensionIndex = initialPath.lastIndexOf(".");
    const baseName = extensionIndex >= 0 ? initialPath.slice(0, extensionIndex) : initialPath;
    const extension = extensionIndex >= 0 ? initialPath.slice(extensionIndex) : "";

    let attempt = 2;
    while (this.app.vault.getAbstractFileByPath(`${baseName}-${attempt}${extension}`)) {
      attempt += 1;
    }

    return `${baseName}-${attempt}${extension}`;
  }

  async collectUnfinishedTasks(): Promise<ParsedObsidianTask[]> {
    const markdownFiles = this.app.vault
      .getMarkdownFiles()
      .filter((file) => !this.isExcludedPath(file.path));

    const parsedTaskTrees = await Promise.all(markdownFiles.map(async (file) => this.parseTasksFromFile(file)));
    return parsedTaskTrees.flatMap((taskList) => taskList.filter((task) => !task.completed));
  }

  async collectAllTasks(): Promise<ParsedObsidianTask[]> {
    const markdownFiles = this.app.vault
      .getMarkdownFiles()
      .filter((file) => !this.isExcludedPath(file.path));

    const parsedTaskTrees = await Promise.all(markdownFiles.map(async (file) => this.parseTasksFromFile(file)));
    return parsedTaskTrees.flatMap((taskList) => taskList.flatMap((task) => flattenParsedTaskTree(task)));
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
      const omniFocusId = await runOmniFocusAppleScript(task);
      return {
        ok: true,
        omniFocusId
      };
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

  async syncCompletionStateBidirectional(): Promise<CompletionSyncSummary> {
    const runtimeValidationError = this.validateOmniFocusRuntime();
    if (runtimeValidationError) {
      return {
        compared: 0,
        updatedInObsidian: 0,
        updatedInOmniFocus: 0,
        missingInOmniFocus: 0,
        missingInObsidian: 0,
        failedUpdates: 1,
        firstFailureMessage: runtimeValidationError
      };
    }

    const records = Object.values(this.state.exportedTasks).filter((record) => Boolean(record.omniFocusId));
    if (records.length === 0) {
      return {
        compared: 0,
        updatedInObsidian: 0,
        updatedInOmniFocus: 0,
        missingInOmniFocus: 0,
        missingInObsidian: 0,
        failedUpdates: 0
      };
    }

    const statuses = await fetchOmniFocusStatuses(records.map((record) => record.omniFocusId!).filter(Boolean));
    const statusMap = new Map(statuses.map((status) => [status.id, status]));
    const obsidianTasks = await this.collectAllTasks();
    const taskMap = new Map(obsidianTasks.map((task) => [this.createTaskFingerprint(task), task]));

    let updatedInObsidian = 0;
    let updatedInOmniFocus = 0;
    let missingInOmniFocus = 0;
    let missingInObsidian = 0;
    let failedUpdates = 0;
    let firstFailureMessage: string | undefined;

    for (const record of records) {
      const status = record.omniFocusId ? statusMap.get(record.omniFocusId) : undefined;
      if (!status || status.missing) {
        missingInOmniFocus += 1;
        continue;
      }

      const obsidianTask = taskMap.get(record.fingerprint);
      if (!obsidianTask) {
        missingInObsidian += 1;
        continue;
      }

      if (status.completed && !obsidianTask.completed) {
        try {
          await this.setObsidianTaskCompletion(obsidianTask, true);
          updatedInObsidian += 1;
        } catch (error) {
          failedUpdates += 1;
          firstFailureMessage ??= error instanceof Error ? error.message : "Failed to update Obsidian task completion.";
        }
        continue;
      }

      if (!status.completed && obsidianTask.completed && record.omniFocusId) {
        try {
          await setOmniFocusTaskCompletion(record.omniFocusId, true);
          updatedInOmniFocus += 1;
        } catch (error) {
          failedUpdates += 1;
          firstFailureMessage ??= error instanceof Error ? error.message : "Failed to update OmniFocus task completion.";
        }
      }
    }

    return {
      compared: records.length,
      updatedInObsidian,
      updatedInOmniFocus,
      missingInOmniFocus,
      missingInObsidian,
      failedUpdates,
      firstFailureMessage
    };
  }

  async setObsidianTaskCompletion(task: ParsedObsidianTask, completed: boolean): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.sourcePath);
    if (!(file instanceof TFile)) {
      throw new Error(`Could not find Obsidian file: ${task.sourcePath}`);
    }

    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/);
    const lineIndex = task.sourceLine - 1;

    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(`Invalid source line ${task.sourceLine} for ${task.sourcePath}`);
    }

    const line = lines[lineIndex];
    const taskMatch = line.match(TASK_LINE_PATTERN);
    if (!taskMatch) {
      throw new Error(`Could not locate task checkbox at ${task.sourcePath}:${task.sourceLine}`);
    }

    const nextStatus = completed ? "x" : " ";
    lines[lineIndex] = `${taskMatch[1]}${taskMatch[2].replace(`[${taskMatch[3]}]`, `[${nextStatus}]`)}${taskMatch[4]}`;
    await this.app.vault.modify(file, lines.join("\n"));
  }

  createCompletionSyncNotice(summary: CompletionSyncSummary): string {
    if (summary.firstFailureMessage) {
      return `Completion sync: compared ${summary.compared}, updated Obsidian ${summary.updatedInObsidian}, updated OmniFocus ${summary.updatedInOmniFocus}, missing OmniFocus ${summary.missingInOmniFocus}, missing Obsidian ${summary.missingInObsidian}, failures ${summary.failedUpdates}. First error: ${summary.firstFailureMessage}`;
    }

    return `Completion sync: compared ${summary.compared}, updated Obsidian ${summary.updatedInObsidian}, updated OmniFocus ${summary.updatedInOmniFocus}, missing OmniFocus ${summary.missingInOmniFocus}, missing Obsidian ${summary.missingInObsidian}, failures ${summary.failedUpdates}.`;
  }

  createSyncNotice(summary: SyncSummary): string {
    const { dedupeSummary } = summary;
    const reportSuffix = summary.issueReportPath ? ` Details file: ${summary.issueReportPath}.` : "";

    if (summary.dryRun) {
      return `Dry run: prepared ${dedupeSummary.totalPrepared} tasks, ${dedupeSummary.pendingExportTasks.length} pending export, ${dedupeSummary.alreadyExportedTasks.length} already recorded, ${dedupeSummary.duplicateInScanCount} duplicate(s) in this scan.${reportSuffix}`;
    }

    if (summary.errorMessage) {
      return `${summary.errorMessage} Prepared ${dedupeSummary.totalPrepared} tasks, but no export was performed.${reportSuffix}`;
    }

    if (dedupeSummary.pendingExportTasks.length === 0) {
      return `Sync complete: no new tasks to export. Skipped ${dedupeSummary.alreadyExportedTasks.length}, duplicate(s) in scan ${dedupeSummary.duplicateInScanCount}.${reportSuffix}`;
    }

    if (summary.failedTasks.length > 0 && summary.firstFailureMessage) {
      return `Sync complete: created ${summary.createdTasks.length}, skipped ${dedupeSummary.alreadyExportedTasks.length}, failed ${summary.failedTasks.length}. First error: ${summary.firstFailureMessage}${reportSuffix}`;
    }

    return `Sync complete: created ${summary.createdTasks.length}, skipped ${dedupeSummary.alreadyExportedTasks.length}, failed ${summary.failedTasks.length}, duplicate(s) in scan ${dedupeSummary.duplicateInScanCount}.${reportSuffix}`;
  }

  createExportRecord(task: PreparedOmniFocusTask, omniFocusId?: string): ExportRecord {
    return {
      fingerprint: task.fingerprint,
      createdAt: new Date().toISOString(),
      sourcePath: task.sourcePath,
      sourceLine: task.sourceLine,
      title: task.title,
      note: task.note,
      omniFocusId
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

    if (taskMatch[4].trim().length === 0) {
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

  if (title.length === 0) {
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

      if (candidateTaskMatch[4].trim().length === 0) {
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
      completed: isCompletedTask(status),
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

async function runOmniFocusAppleScript(task: PreparedOmniFocusTask): Promise<string> {
  const script = buildOmniFocusAppleScript(task);
  return runAppleScriptCapture(script);
}

function buildOmniFocusAppleScript(task: PreparedOmniFocusTask): string {
  const lines = [
    "tell application \"OmniFocus\"",
    "  tell default document"
  ];

  appendTaskCreationLines(lines, task, "rootTask", 2, null);
  lines.push("    return id of rootTask");
  lines.push("  end tell", "end tell");

  return lines.join("\n");
}

async function runAppleScriptCapture(script: string, args: string[] = []): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile("osascript", ["-e", script, "--", ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

async function fetchOmniFocusStatuses(ids: string[]): Promise<OmniFocusTaskStatus[]> {
  if (ids.length === 0) {
    return [];
  }

  const script = [
    "on run argv",
    "set outputLines to {}",
    "tell application \"OmniFocus\"",
    "tell default document",
    "repeat with taskId in argv",
    "try",
    "set matchedTask to first flattened task where its id is (contents of taskId)",
    "set end of outputLines to ((id of matchedTask as text) & \"|\" & (completed of matchedTask as text))",
    "on error",
    "set end of outputLines to ((contents of taskId) & \"|missing\")",
    "end try",
    "end repeat",
    "end tell",
    "end tell",
    "set AppleScript's text item delimiters to linefeed",
    "return outputLines as text",
    "end run"
  ].join("\n");

  const output = await runAppleScriptCapture(script, ids);
  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf("|");
      const id = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
      const rawStatus = separatorIndex >= 0 ? line.slice(separatorIndex + 1).toLowerCase() : "missing";
      return {
        id,
        completed: rawStatus === "true",
        missing: rawStatus === "missing"
      };
    });
}

async function setOmniFocusTaskCompletion(taskId: string, completed: boolean): Promise<void> {
  const script = [
    "on run argv",
    "set targetId to item 1 of argv",
    "set targetCompleted to item 2 of argv",
    "tell application \"OmniFocus\"",
    "tell default document",
    "set matchedTask to first flattened task where its id is targetId",
    "if targetCompleted is \"true\" then",
    "try",
    "mark complete matchedTask",
    "on error",
    "try",
    "set completion date of matchedTask to (current date)",
    "on error errorMessage number errorNumber",
    "error errorMessage number errorNumber",
    "end try",
    "end try",
    "else",
    "try",
    "mark incomplete matchedTask",
    "on error",
    "try",
    "set completion date of matchedTask to missing value",
    "on error errorMessage number errorNumber",
    "error errorMessage number errorNumber",
    "end try",
    "end try",
    "end if",
    "end tell",
    "end tell",
    "end run"
  ].join("\n");

  await runAppleScript(script, [taskId, completed ? "true" : "false"]);
}

function flattenParsedTaskTree(rootTask: ParsedObsidianTask): ParsedObsidianTask[] {
  const flattenedTasks: ParsedObsidianTask[] = [rootTask];
  rootTask.children.forEach((child) => {
    flattenedTasks.push(...flattenParsedTaskTree(child));
  });

  return flattenedTasks;
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