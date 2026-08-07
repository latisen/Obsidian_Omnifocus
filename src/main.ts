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
    return [
      FINGERPRINT_VERSION,
      normalizeFingerprintValue(task.sourcePath),
      stableReference,
      heading,
      normalizeFingerprintValue(task.title),
      normalizeFingerprintValue(task.note)
    ]
      .join("::");
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
      fingerprint: this.createTaskFingerprint(task)
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

    for (const task of dedupeSummary.pendingExportTasks) {
      const exported = this.exportTaskToOmniFocus(task);
      if (!exported) {
        failedTasks.push(task);
        continue;
      }

      await this.rememberExport(task);
      createdTasks.push(task);
    }

    return {
      dedupeSummary,
      createdTasks,
      failedTasks,
      dryRun: false
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

  createOmniFocusAddUrl(task: PreparedOmniFocusTask): string {
    const searchParams = new URLSearchParams({
      name: task.title,
      note: task.note
    });

    return `omnifocus:///add?${searchParams.toString()}`;
  }

  validateOmniFocusRuntime(): string | null {
    if (!Platform.isDesktopApp) {
      return "OmniFocus sync requires Obsidian Desktop.";
    }

    if (!Platform.isMacOS) {
      return "OmniFocus sync requires macOS with OmniFocus installed.";
    }

    if (typeof window === "undefined" || typeof window.open !== "function") {
      return "This environment cannot open the OmniFocus URL scheme.";
    }

    return null;
  }

  exportTaskToOmniFocus(task: PreparedOmniFocusTask): boolean {
    const url = this.createOmniFocusAddUrl(task);

    try {
      const openedWindow = window.open(url, "_blank");
      return openedWindow !== null;
    } catch (error) {
      console.error("Failed to open OmniFocus URL", { error, task, url });
      return false;
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

    const indent = taskMatch[1];
    const status = taskMatch[3];
    const title = taskMatch[4].trim();

    if (isCompletedTask(status) || title.length === 0) {
      continue;
    }

    const noteLines: string[] = [];
    let nextIndex = index + 1;

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
        const currentIndentLength = getIndentWidth(indent);
        if (candidateIndentLength <= currentIndentLength) {
          break;
        }
      }

      const continuationIndentLength = getIndentWidth(candidateLine.match(/^([ \t]*)/)?.[1] ?? "");
      const minimumChildIndent = getIndentWidth(indent) + 1;
      if (continuationIndentLength < minimumChildIndent) {
        break;
      }

      noteLines.push(stripContinuationIndent(candidateLine, minimumChildIndent));
      nextIndex += 1;
    }

    while (noteLines.length > 0 && noteLines[noteLines.length - 1] === "") {
      noteLines.pop();
    }

    tasks.push({
      title,
      note: noteLines.join("\n"),
      sourcePath,
      sourceLine: index + 1,
      headingPath: [...headingPath],
      rawTaskLine: line
    });

    index = nextIndex - 1;
  }

  return tasks;
}

function isCompletedTask(status: string): boolean {
  return status.trim().toLowerCase() === "x";
}

function normalizeFingerprintValue(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
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