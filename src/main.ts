import { execFile } from "node:child_process";
import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from "obsidian";

interface ExportRecord {
  fingerprint: string;
  createdAt: string;
  sourcePath: string;
  sourceLine?: number;
  title: string;
  note: string;
  omniFocusId?: string;
  plannedEpochSeconds?: number | null;
  dueEpochSeconds?: number | null;
}

interface ParsedObsidianTask {
  title: string;
  note: string;
  completed: boolean;
  plannedEpochSeconds: number | null;
  dueEpochSeconds: number | null;
  sourcePath: string;
  sourceLine: number;
  headingPath: string[];
  rawTaskLine: string;
  children: ParsedObsidianTask[];
}

interface PreparedOmniFocusTask {
  title: string;
  note: string;
  plannedEpochSeconds: number | null;
  dueEpochSeconds: number | null;
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

interface SyncFailureContext {
  task: PreparedOmniFocusTask;
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
  plannedEpochSeconds: number | null;
  dueEpochSeconds: number | null;
  plannedDateText: string | null;
  dueDateText: string | null;
  projectName: string | null;
  omniFocusTaskUrl: string | null;
  missing: boolean;
}

interface CompletionSyncSummary {
  compared: number;
  updatedInObsidian: number;
  updatedInOmniFocus: number;
  updatedScheduleInObsidian: number;
  updatedScheduleInOmniFocus: number;
  scheduleConflicts: number;
  missingInOmniFocus: number;
  missingInObsidian: number;
  failedUpdates: number;
  firstFailureMessage?: string;
}

interface FullSyncSummary {
  exportSummary: SyncSummary;
  completionSummary: CompletionSyncSummary;
}

interface OmniFocusPluginState {
  exportedTasks: Record<string, ExportRecord>;
}

interface OmniFocusPluginSettings {
  vaultName: string;
  excludedFolders: string;
  dryRun: boolean;
  enableSyncLog: boolean;
  autoFullSyncIntervalMinutes: number;
  lmStudioBaseUrl: string;
  lmStudioModel: string;
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
  dryRun: true,
  enableSyncLog: true,
  autoFullSyncIntervalMinutes: 0,
  lmStudioBaseUrl: "http://127.0.0.1:1234",
  lmStudioModel: "local-model"
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
  autoFullSyncIntervalId: number | null = null;
  autoFullSyncInProgress = false;
  activeSyncIssues: SyncIssue[] = [];

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
      id: "run-full-vault-sync",
      name: "Run full vault sync (export + completion)",
      callback: async () => {
        const summary = await this.runFullVaultSync();
        new Notice(this.createFullSyncNotice(summary), 12000);
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

    this.addCommand({
      id: "generate-ai-task-suggestions-for-active-note",
      name: "Generate task suggestions with LM Studio for active note",
      callback: async () => {
        await this.generateAiTaskSuggestionsForActiveNote();
      }
    });

    this.addSettingTab(new OmniFocusSettingTab(this.app, this));
    this.configureAutoFullSync();
  }

  override onunload(): void {
    this.stopAutoFullSync();
  }

  configureAutoFullSync(): void {
    this.stopAutoFullSync();

    const intervalMinutes = this.settings.autoFullSyncIntervalMinutes;
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      return;
    }

    const intervalMs = Math.max(1, Math.round(intervalMinutes)) * 60 * 1000;
    this.autoFullSyncIntervalId = window.setInterval(() => {
      void this.runAutoFullSyncTick();
    }, intervalMs);
  }

  stopAutoFullSync(): void {
    if (this.autoFullSyncIntervalId !== null) {
      window.clearInterval(this.autoFullSyncIntervalId);
      this.autoFullSyncIntervalId = null;
    }
  }

  async runAutoFullSyncTick(): Promise<void> {
    if (this.autoFullSyncInProgress) {
      return;
    }

    this.autoFullSyncInProgress = true;
    try {
      await this.runFullVaultSync();
    } catch (error) {
      console.error("Automatic full vault sync failed", error);
    } finally {
      this.autoFullSyncInProgress = false;
    }
  }

  async generateAiTaskSuggestionsForActiveNote(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== "md") {
      new Notice("Open a markdown note first.");
      return;
    }

    const noteContent = await this.app.vault.read(activeFile);
    if (noteContent.trim().length === 0) {
      new Notice("Active note is empty.");
      return;
    }

    let generatedTaskList: string;
    try {
      generatedTaskList = await this.requestTaskSuggestionsFromLmStudio(noteContent);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown LM Studio error.";
      new Notice(`LM Studio request failed: ${message}`, 10000);
      return;
    }

    const timestamp = new Date().toLocaleString();
    const aiSection = [
      "",
      `# AI task suggestions (${timestamp})`,
      "",
      generatedTaskList.trim()
    ].join("\n");

    const nextContent = noteContent.endsWith("\n") ? `${noteContent}${aiSection}\n` : `${noteContent}\n${aiSection}\n`;
    await this.app.vault.modify(activeFile, nextContent);
    new Notice(`AI task suggestions added to ${activeFile.path}.`, 9000);
  }

  async requestTaskSuggestionsFromLmStudio(noteContent: string): Promise<string> {
    const baseUrl = this.settings.lmStudioBaseUrl.trim().replace(/\/+$/, "");
    if (baseUrl.length === 0) {
      throw new Error("LM Studio base URL is empty.");
    }

    const model = this.settings.lmStudioModel.trim() || "local-model";
    const prompt = [
      "Du är en assistent som hittar konkreta uppgifter i en anteckning.",
      "Returnera ENDAST en markdown-lista med checkboxar.",
      "Varje rad måste ha formatet: - [ ] <uppgift>",
      "Max 12 uppgifter.",
      "",
      "Anteckning:",
      noteContent
    ].join("\n");

    const response = await requestUrl({
      url: `${baseUrl}/v1/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "Svara alltid med en ren markdown-checklista utan förklarande text."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const rawContent = response.json?.choices?.[0]?.message?.content;
    if (typeof rawContent !== "string" || rawContent.trim().length === 0) {
      throw new Error("LM Studio returned empty content.");
    }

    const normalized = this.normalizeAiTaskList(rawContent);
    if (normalized.trim().length === 0) {
      throw new Error("LM Studio response did not contain any actionable tasks.");
    }

    return normalized;
  }

  normalizeAiTaskList(input: string): string {
    const withoutCodeFences = input.replace(/```[a-zA-Z]*\n?|```/g, "").trim();
    const lines = withoutCodeFences
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return "";
    }

    const normalizedLines = lines.map((line) => {
      if (/^[-*]\s+\[[ xX]\]\s+/.test(line)) {
        return line.replace(/^[-*]\s+\[[xX]\]\s+/, "- [ ] ").replace(/^\*\s+/, "- ");
      }

      if (/^[-*]\s+/.test(line)) {
        return `- [ ] ${line.replace(/^[-*]\s+/, "").trim()}`;
      }

      if (/^\d+[.)]\s+/.test(line)) {
        return `- [ ] ${line.replace(/^\d+[.)]\s+/, "").trim()}`;
      }

      return `- [ ] ${line}`;
    });

    return normalizedLines.join("\n");
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
      plannedEpochSeconds: task.plannedEpochSeconds,
      dueEpochSeconds: task.dueEpochSeconds,
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
    const parsedTaskByFingerprint = new Map(parsedTasks.map((task) => [this.createTaskFingerprint(task), task]));
    const parsedTaskByPathAndLine = new Map(parsedTasks.map((task) => [`${task.sourcePath}:${task.sourceLine}`, task]));
    const preparedTasks = parsedTasks.map((task) => this.prepareTaskForOmniFocus(task));
    const dedupeSummary = this.buildDedupeSummary(preparedTasks);
    this.activeSyncIssues = [];

    const scheduleDetailsByFingerprint = new Map<string, string>();
    const trackedOmniFocusIds = dedupeSummary.alreadyExportedTasks
      .map((task) => this.state.exportedTasks[task.fingerprint]?.omniFocusId)
      .filter((id): id is string => Boolean(id));

    if (trackedOmniFocusIds.length > 0 && !this.settings.dryRun) {
      const runtimeValidationError = this.validateOmniFocusRuntime();
      if (!runtimeValidationError) {
        const statuses = await fetchOmniFocusStatuses(trackedOmniFocusIds);
        const statusMap = new Map(statuses.map((status) => [status.id, status]));

        dedupeSummary.alreadyExportedTasks.forEach((task) => {
          const record = this.state.exportedTasks[task.fingerprint];
          const status = record?.omniFocusId ? statusMap.get(record.omniFocusId) : undefined;
          if (!status) {
            return;
          }

          const plannedValue = status.plannedDateText ?? "";
          const dueValue = status.dueDateText ?? "";
          scheduleDetailsByFingerprint.set(task.fingerprint, `OmniFocus planned="${plannedValue}" due="${dueValue}"`);
        });
      }
    }

    const syncIssues: SyncIssue[] = this.createDedupeSyncIssues(dedupeSummary, scheduleDetailsByFingerprint);
    syncIssues.forEach((issue) => this.activeSyncIssues.push(issue));

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

    const createdTasks: PreparedOmniFocusTask[] = [];
    const failedTasks: PreparedOmniFocusTask[] = [];
    const syncFailures: SyncFailureContext[] = [];
    let firstFailureMessage: string | undefined;

    for (const task of dedupeSummary.alreadyExportedTasks) {
      const record = this.state.exportedTasks[task.fingerprint];
      if (!record?.omniFocusId) {
        continue;
      }

      let currentTask = parsedTaskByFingerprint.get(task.fingerprint);
      if (!currentTask) {
        currentTask = parsedTaskByPathAndLine.get(`${task.sourcePath}:${task.sourceLine}`) ?? null;
      }

      if (!currentTask) {
        continue;
      }

      try {
        await this.reconcileExistingTaskSchedule(task, currentTask, record);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Failed to reconcile existing task schedule.";
        syncFailures.push({ task, reason: detail });
        this.appendSyncIssue(task, detail);
        firstFailureMessage ??= detail;
      }
    }

    if (dedupeSummary.pendingExportTasks.length === 0) {
      return this.finalizeSyncSummary({
        dedupeSummary,
        createdTasks: [],
        failedTasks: [],
        dryRun: false
      }, syncIssues);
    }

    for (const task of dedupeSummary.pendingExportTasks) {
      const exported = await this.exportTaskToOmniFocus(task);
      if (!exported.ok) {
        failedTasks.push(task);
        const detail = exported.errorMessage ?? "Unknown AppleScript error.";
        syncFailures.push({ task, reason: detail });
        this.appendSyncIssue(task, `Export failed: ${detail}`);
        firstFailureMessage ??= detail;
        syncIssues.push(this.createSyncIssue(task, `Export failed: ${detail}`));
        continue;
      }

      await this.rememberExport(this.createExportRecord(task, exported.omniFocusId));
      createdTasks.push(task);
    }

    syncFailures.forEach((failure) => {
      const issue = this.createSyncIssue(failure.task, `Sync failure: ${failure.reason}`);
      syncIssues.push(issue);
      this.activeSyncIssues.push(issue);
    });

    return this.finalizeSyncSummary({
      dedupeSummary,
      createdTasks,
      failedTasks,
      dryRun: false,
      firstFailureMessage
    }, syncIssues);
  }

  createDedupeSyncIssues(dedupeSummary: DedupeSummary, scheduleDetailsByFingerprint?: Map<string, string>): SyncIssue[] {
    const issues: SyncIssue[] = [];

    dedupeSummary.alreadyExportedTasks.forEach((task) => {
      const detail = scheduleDetailsByFingerprint?.get(task.fingerprint);
      const reason = detail
        ? `Skipped: already exported (fingerprint exists in cache). ${detail}`
        : "Skipped: already exported (fingerprint exists in cache).";
      issues.push(this.createSyncIssue(task, reason));
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
    if (syncIssues.length === 0 || !this.settings.enableSyncLog) {
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
    const normalizedNoteBody = normalizeMarkdownLinksForOmniFocus(noteBody.trim());
    const sections = [normalizedNoteBody, `Obsidian: ${backlinkLabel}\n${backlinkUrl}`].filter((value) => value.length > 0);
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

  appendSyncIssue(task: PreparedOmniFocusTask, reason: string): void {
    this.activeSyncIssues.push(this.createSyncIssue(task, reason));
  }

  appendSyncIssueForRecord(record: ExportRecord, reason: string): void {
    this.activeSyncIssues.push({
      title: record.title,
      sourcePath: record.sourcePath,
      sourceLine: record.sourceLine ?? 0,
      reason
    });
  }

  async syncCompletionStateBidirectional(): Promise<CompletionSyncSummary> {
    const runtimeValidationError = this.validateOmniFocusRuntime();
    if (runtimeValidationError) {
      return {
        compared: 0,
        updatedInObsidian: 0,
        updatedInOmniFocus: 0,
        updatedScheduleInObsidian: 0,
        updatedScheduleInOmniFocus: 0,
        scheduleConflicts: 0,
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
        updatedScheduleInObsidian: 0,
        updatedScheduleInOmniFocus: 0,
        scheduleConflicts: 0,
        missingInOmniFocus: 0,
        missingInObsidian: 0,
        failedUpdates: 0
      };
    }

    const statuses = await fetchOmniFocusStatuses(records.map((record) => record.omniFocusId!).filter(Boolean));
    const statusMap = new Map(statuses.map((status) => [status.id, status]));
    const obsidianTasks = await this.collectAllTasks();
    const taskMap = new Map(obsidianTasks.map((task) => [this.createTaskFingerprint(task), task]));
    const taskMapByPathAndLine = new Map(obsidianTasks.map((task) => [`${task.sourcePath}:${task.sourceLine}`, task]));

    let updatedInObsidian = 0;
    let updatedInOmniFocus = 0;
    let updatedScheduleInObsidian = 0;
    let updatedScheduleInOmniFocus = 0;
    let scheduleConflicts = 0;
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

      let obsidianTask = taskMap.get(record.fingerprint);
      if (!obsidianTask) {
        obsidianTask = taskMapByPathAndLine.get(`${record.sourcePath}:${record.sourceLine ?? ""}`) ?? null;
      }

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

      if (!record.omniFocusId) {
        continue;
      }

      const recordPlanned = normalizeEpochSeconds(record.plannedEpochSeconds);
      const recordDue = normalizeEpochSeconds(record.dueEpochSeconds);
      const obsidianPlanned = normalizeEpochSeconds(obsidianTask.plannedEpochSeconds);
      const obsidianDue = normalizeEpochSeconds(obsidianTask.dueEpochSeconds);
      const omniPlanned = normalizeEpochSeconds(status.plannedEpochSeconds);
      const omniDue = normalizeEpochSeconds(status.dueEpochSeconds);
      const omniPlannedText = status.plannedDateText ?? (omniPlanned === null ? null : formatEpochForObsidian(omniPlanned));
      const omniDueText = status.dueDateText ?? (omniDue === null ? null : formatEpochForObsidian(omniDue));

      if (status.projectName || status.omniFocusTaskUrl) {
        try {
          await this.setObsidianTaskOmniMetadata(obsidianTask, status.projectName, status.omniFocusTaskUrl);
        } catch (error) {
          failedUpdates += 1;
          const detail = error instanceof Error ? error.message : "Failed to update Obsidian task OmniFocus metadata.";
          firstFailureMessage ??= detail;
          this.appendSyncIssueForRecord(record, `Metadata sync failed: ${detail}`);
        }
      }

      const hasScheduleBaseline = hasRecordScheduleBaseline(record);
      if (!hasScheduleBaseline) {
        if (areEpochValuesEqual(obsidianPlanned, omniPlanned) && areEpochValuesEqual(obsidianDue, omniDue)) {
          record.plannedEpochSeconds = obsidianPlanned;
          record.dueEpochSeconds = obsidianDue;
          await this.savePluginData();
          continue;
        }

        const omniHasAnySchedule = hasAnyScheduleValue(omniPlanned, omniDue);
        const obsidianHasAnySchedule = hasAnyScheduleValue(obsidianPlanned, obsidianDue);

        if (omniHasAnySchedule || !obsidianHasAnySchedule) {
          try {
            await this.setObsidianTaskScheduling(obsidianTask, omniPlanned, omniDue, omniPlannedText, omniDueText);
            record.plannedEpochSeconds = omniPlanned;
            record.dueEpochSeconds = omniDue;
            await this.savePluginData();
            updatedScheduleInObsidian += 1;
          } catch (error) {
            failedUpdates += 1;
            const detail = error instanceof Error ? error.message : "Failed to initialize Obsidian task schedule from OmniFocus.";
            firstFailureMessage ??= detail;
            this.appendSyncIssueForRecord(record, `Schedule sync failed: ${detail}`);
          }
          continue;
        }

        try {
          await setOmniFocusTaskScheduling(record.omniFocusId, obsidianPlanned, obsidianDue);
          record.plannedEpochSeconds = obsidianPlanned;
          record.dueEpochSeconds = obsidianDue;
          await this.savePluginData();
          updatedScheduleInOmniFocus += 1;
        } catch (error) {
          failedUpdates += 1;
          const detail = error instanceof Error ? error.message : "Failed to initialize OmniFocus task schedule from Obsidian.";
          firstFailureMessage ??= detail;
          this.appendSyncIssueForRecord(record, `Schedule sync failed: ${detail}`);
        }
        continue;
      }

      const shouldPropagateOmniToObsidian = (obsidianPlanned === null && omniPlanned !== null) || (obsidianDue === null && omniDue !== null);
      const shouldPropagateObsidianToOmni = (obsidianPlanned !== null && omniPlanned === null) || (obsidianDue !== null && omniDue === null);

      if (shouldPropagateOmniToObsidian) {
        const plannedForObsidian = obsidianPlanned ?? omniPlanned;
        const dueForObsidian = obsidianDue ?? omniDue;
        try {
          await this.setObsidianTaskScheduling(obsidianTask, plannedForObsidian, dueForObsidian, omniPlannedText, omniDueText);
          record.plannedEpochSeconds = plannedForObsidian;
          record.dueEpochSeconds = dueForObsidian;
          await this.savePluginData();
          updatedScheduleInObsidian += 1;
        } catch (error) {
          failedUpdates += 1;
          firstFailureMessage ??= error instanceof Error ? error.message : "Failed to sync OmniFocus schedule into Obsidian.";
        }
        continue;
      }

      if (shouldPropagateObsidianToOmni) {
        const plannedForOmni = obsidianPlanned ?? omniPlanned;
        const dueForOmni = obsidianDue ?? omniDue;
        try {
          await setOmniFocusTaskScheduling(record.omniFocusId, plannedForOmni, dueForOmni);
          record.plannedEpochSeconds = plannedForOmni;
          record.dueEpochSeconds = dueForOmni;
          await this.savePluginData();
          updatedScheduleInOmniFocus += 1;
        } catch (error) {
          failedUpdates += 1;
          firstFailureMessage ??= error instanceof Error ? error.message : "Failed to sync Obsidian schedule into OmniFocus.";
        }
        continue;
      }

      const obsidianChangedFromRecord = !areEpochValuesEqual(obsidianPlanned, recordPlanned) || !areEpochValuesEqual(obsidianDue, recordDue);
      const omniChangedFromRecord = !areEpochValuesEqual(omniPlanned, recordPlanned) || !areEpochValuesEqual(omniDue, recordDue);

      if (obsidianChangedFromRecord && omniChangedFromRecord) {
        if (areEpochValuesEqual(obsidianPlanned, omniPlanned) && areEpochValuesEqual(obsidianDue, omniDue)) {
          record.plannedEpochSeconds = obsidianPlanned;
          record.dueEpochSeconds = obsidianDue;
          await this.savePluginData();
          continue;
        }

        scheduleConflicts += 1;
        continue;
      }

      if (obsidianChangedFromRecord) {
        try {
          await setOmniFocusTaskScheduling(record.omniFocusId, obsidianPlanned, obsidianDue);
          record.plannedEpochSeconds = obsidianPlanned;
          record.dueEpochSeconds = obsidianDue;
          await this.savePluginData();
          updatedScheduleInOmniFocus += 1;
        } catch (error) {
          failedUpdates += 1;
          const detail = error instanceof Error ? error.message : "Failed to update OmniFocus task schedule.";
          firstFailureMessage ??= detail;
          this.appendSyncIssueForRecord(record, `Schedule sync failed: ${detail}`);
        }
        continue;
      }

      if (omniChangedFromRecord) {
        try {
          await this.setObsidianTaskScheduling(obsidianTask, omniPlanned, omniDue, omniPlannedText, omniDueText);
          record.plannedEpochSeconds = omniPlanned;
          record.dueEpochSeconds = omniDue;
          await this.savePluginData();
          updatedScheduleInObsidian += 1;
        } catch (error) {
          failedUpdates += 1;
          const detail = error instanceof Error ? error.message : "Failed to update Obsidian task schedule.";
          firstFailureMessage ??= detail;
          this.appendSyncIssueForRecord(record, `Schedule sync failed: ${detail}`);
        }
      }
    }

    return {
      compared: records.length,
      updatedInObsidian,
      updatedInOmniFocus,
      updatedScheduleInObsidian,
      updatedScheduleInOmniFocus,
      scheduleConflicts,
      missingInOmniFocus,
      missingInObsidian,
      failedUpdates,
      firstFailureMessage
    };
  }

  async runFullVaultSync(): Promise<FullSyncSummary> {
    const exportSummary = await this.syncTasksToOmniFocus();
    const completionSummary = await this.syncCompletionStateBidirectional();

    if (this.activeSyncIssues.length > 0) {
      const combinedIssues = [...this.activeSyncIssues];
      await this.writeSyncIssuesReport({
        dedupeSummary: {
          totalPrepared: exportSummary.dedupeSummary.totalPrepared,
          uniqueTasks: exportSummary.dedupeSummary.uniqueTasks,
          duplicateInScanCount: exportSummary.dedupeSummary.duplicateInScanCount,
          duplicateInScanTasks: exportSummary.dedupeSummary.duplicateInScanTasks,
          alreadyExportedTasks: exportSummary.dedupeSummary.alreadyExportedTasks,
          pendingExportTasks: exportSummary.dedupeSummary.pendingExportTasks
        },
        createdTasks: exportSummary.createdTasks,
        failedTasks: exportSummary.failedTasks,
        dryRun: exportSummary.dryRun,
        firstFailureMessage: exportSummary.firstFailureMessage,
        errorMessage: exportSummary.errorMessage
      }, combinedIssues);
    }

    return {
      exportSummary,
      completionSummary
    };
  }

  async reconcileExistingTaskSchedule(task: PreparedOmniFocusTask, currentTask: ParsedObsidianTask, record: ExportRecord): Promise<void> {
    if (!record.omniFocusId) {
      return;
    }

    const statuses = await fetchOmniFocusStatuses([record.omniFocusId]);
    const status = statuses[0];
    if (!status || status.missing) {
      return;
    }

    const obsidianPlanned = normalizeEpochSeconds(currentTask.plannedEpochSeconds);
    const obsidianDue = normalizeEpochSeconds(currentTask.dueEpochSeconds);
    const omniPlanned = normalizeEpochSeconds(status.plannedEpochSeconds);
    const omniDue = normalizeEpochSeconds(status.dueEpochSeconds);

    if (status.projectName || status.omniFocusTaskUrl) {
      await this.setObsidianTaskOmniMetadata(currentTask, status.projectName, status.omniFocusTaskUrl);
    }

    if (!hasAnyScheduleValue(omniPlanned, omniDue)) {
      return;
    }

    const needsObsidianUpdate = !areEpochValuesEqual(obsidianPlanned, omniPlanned) || !areEpochValuesEqual(obsidianDue, omniDue);
    if (!needsObsidianUpdate) {
      record.plannedEpochSeconds = omniPlanned;
      record.dueEpochSeconds = omniDue;
      await this.savePluginData();
      return;
    }

    await this.setObsidianTaskScheduling(currentTask, omniPlanned, omniDue, status.plannedDateText ?? (omniPlanned === null ? null : formatEpochForObsidian(omniPlanned)), status.dueDateText ?? (omniDue === null ? null : formatEpochForObsidian(omniDue)));
    record.plannedEpochSeconds = omniPlanned;
    record.dueEpochSeconds = omniDue;
    await this.savePluginData();
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

  async setObsidianTaskScheduling(task: ParsedObsidianTask, plannedEpochSeconds: number | null, dueEpochSeconds: number | null, plannedDateText: string | null = null, dueDateText: string | null = null): Promise<void> {
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
      throw new Error(`Could not locate task line at ${task.sourcePath}:${task.sourceLine}`);
    }

    const plannedValue = normalizeOmniDateTextForObsidian(plannedDateText) ?? formatEpochForObsidian(plannedEpochSeconds);
    const dueValue = normalizeOmniDateTextForObsidian(dueDateText) ?? formatEpochForObsidian(dueEpochSeconds);
    let updatedTaskBody = setInlineFieldValue(taskMatch[4], "planned", plannedValue);
    updatedTaskBody = setInlineFieldValue(updatedTaskBody, "due", dueValue);

    lines[lineIndex] = `${taskMatch[1]}${taskMatch[2]}${updatedTaskBody}`;
    await this.app.vault.modify(file, lines.join("\n"));
  }

  async setObsidianTaskOmniMetadata(task: ParsedObsidianTask, projectName: string | null, omniFocusTaskUrl: string | null): Promise<void> {
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
      throw new Error(`Could not locate task line at ${task.sourcePath}:${task.sourceLine}`);
    }

    const normalizedProject = normalizeProjectValueForObsidian(projectName);
    const normalizedOmniFocusUrl = normalizeOmniFocusTaskUrlForObsidian(omniFocusTaskUrl);
    let updatedTaskBody = setInlineFieldValue(taskMatch[4], "project", normalizedProject);
    updatedTaskBody = setOmniFocusLinkValue(updatedTaskBody, normalizedOmniFocusUrl);

    if (updatedTaskBody === taskMatch[4]) {
      return;
    }

    lines[lineIndex] = `${taskMatch[1]}${taskMatch[2]}${updatedTaskBody}`;
    await this.app.vault.modify(file, lines.join("\n"));
  }

  createCompletionSyncNotice(summary: CompletionSyncSummary): string {
    if (summary.firstFailureMessage) {
      return `Completion sync: compared ${summary.compared}, updated Obsidian completion ${summary.updatedInObsidian}, updated OmniFocus completion ${summary.updatedInOmniFocus}, updated Obsidian schedule ${summary.updatedScheduleInObsidian}, updated OmniFocus schedule ${summary.updatedScheduleInOmniFocus}, schedule conflicts ${summary.scheduleConflicts}, missing OmniFocus ${summary.missingInOmniFocus}, missing Obsidian ${summary.missingInObsidian}, failures ${summary.failedUpdates}. First error: ${summary.firstFailureMessage}`;
    }

    return `Completion sync: compared ${summary.compared}, updated Obsidian completion ${summary.updatedInObsidian}, updated OmniFocus completion ${summary.updatedInOmniFocus}, updated Obsidian schedule ${summary.updatedScheduleInObsidian}, updated OmniFocus schedule ${summary.updatedScheduleInOmniFocus}, schedule conflicts ${summary.scheduleConflicts}, missing OmniFocus ${summary.missingInOmniFocus}, missing Obsidian ${summary.missingInObsidian}, failures ${summary.failedUpdates}.`;
  }

  createFullSyncNotice(summary: FullSyncSummary): string {
    const exportNotice = this.createSyncNotice(summary.exportSummary);
    const completionNotice = this.createCompletionSyncNotice(summary.completionSummary);
    return `Full sync complete. ${exportNotice} ${completionNotice}`;
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
      omniFocusId,
      plannedEpochSeconds: task.plannedEpochSeconds,
      dueEpochSeconds: task.dueEpochSeconds
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

  const cleanedTitle = removeInlineDateFields(title);
  const cleanedNoteLines = noteLines.map((noteLine) => removeInlineDateFields(noteLine));
  const normalizedPlanned = parseDateTokenToEpochSeconds(extractInlineFieldValue(title, "planned") ?? extractInlineFieldValue(noteLines.join("\n"), "planned"));
  const normalizedDue = parseDateTokenToEpochSeconds(extractInlineFieldValue(title, "due") ?? extractInlineFieldValue(noteLines.join("\n"), "due"));

  return {
    task: {
      title: cleanedTitle,
      note: cleanedNoteLines.join("\n"),
      completed: isCompletedTask(status),
      plannedEpochSeconds: normalizedPlanned,
      dueEpochSeconds: normalizedDue,
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

function normalizeMarkdownLinksForOmniFocus(input: string): string {
  if (input.length === 0) {
    return input;
  }

  // OmniFocus sometimes includes trailing ')' in URL parsing for markdown links.
  // Convert [label](url) -> "label: url" to preserve both parts without markdown syntax.
  return input.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    return `${label}: ${url}`;
  });
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
    "repeat with taskId in argv",
    "try",
    "set jsCode to \"(() => {\" & linefeed & ¬",
    "\"  const taskID = \" & quoted form of (contents of taskId) & \";\" & linefeed & ¬",
    "\"  const task = Task.byIdentifier(taskID);\" & linefeed & ¬",
    "\"  if (!task) {\" & linefeed & ¬",
    "\"    return JSON.stringify({ missing: true });\" & linefeed & ¬",
    "\"  }\" & linefeed & ¬",
    "\"  const toIso = (value) => {\" & linefeed & ¬",
    "\"    if (!value) return null;\" & linefeed & ¬",
    "\"    try { return value.toISOString(); } catch (error) { return String(value); }\" & linefeed & ¬",
    "\"  };\" & linefeed & ¬",
    "\"  const objectID = (value) => (value && value.id ? value.id.primaryKey : null);\" & linefeed & ¬",
    "\"  const project = task.containingProject || task.project;\" & linefeed & ¬",
    "\"  const projectName = project ? project.name : null;\" & linefeed & ¬",
    "\"  const taskUrl = objectID(task) ? ('omnifocus:///task/' + objectID(task)) : null;\" & linefeed & ¬",
    "\"  return JSON.stringify({\" & linefeed & ¬",
    "\"    missing: false,\" & linefeed & ¬",
    "\"    completed: !!task.completed,\" & linefeed & ¬",
    "\"    plannedDate: toIso(task.plannedDate),\" & linefeed & ¬",
    "\"    dueDate: toIso(task.dueDate),\" & linefeed & ¬",
    "\"    projectName: projectName,\" & linefeed & ¬",
    "\"    taskUrl: taskUrl\" & linefeed & ¬",
    "\"  });\" & linefeed & ¬",
    "\"})();\"",
    "set jsResult to evaluate javascript jsCode",
    "set end of outputLines to ((contents of taskId) & tab & jsResult)",
    "on error errorMessage number errorNumber",
    "set errorPayload to \"{\\\"missing\\\":false,\\\"completed\\\":false,\\\"error\\\":\" & quoted form of (\"AppleScript \" & errorNumber & \": \" & errorMessage) & \"}\"",
    "set end of outputLines to ((contents of taskId) & tab & errorPayload)",
    "end try",
    "end repeat",
    "end tell",
    "set AppleScript's text item delimiters to linefeed",
    "return outputLines as text",
    "end run"
  ].join("\n");

  let output: string;
  try {
    output = await runAppleScriptCapture(script, ids);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return ids.map((id) => ({
      id,
      completed: false,
      plannedEpochSeconds: null,
      dueEpochSeconds: null,
      plannedDateText: `<<ERR:${detail}>>`,
      dueDateText: `<<ERR:${detail}>>`,
      projectName: null,
      omniFocusTaskUrl: null,
      missing: false
    }));
  }

  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tabIndex = line.indexOf("\t");
      if (tabIndex <= 0) {
        return {
          id: "",
          completed: false,
          plannedEpochSeconds: null,
          dueEpochSeconds: null,
          plannedDateText: `<<ERR:Unexpected status line: ${line}>>`,
          dueDateText: `<<ERR:Unexpected status line: ${line}>>`,
          projectName: null,
          omniFocusTaskUrl: null,
          missing: false
        };
      }

      const id = line.slice(0, tabIndex);
      const payloadText = line.slice(tabIndex + 1);

      let payload: {
        missing?: boolean;
        completed?: boolean;
        plannedDate?: string | null;
        dueDate?: string | null;
        projectName?: string | null;
        taskUrl?: string | null;
        error?: string;
      } = {};

      try {
        payload = JSON.parse(payloadText);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          id,
          completed: false,
          plannedEpochSeconds: null,
          dueEpochSeconds: null,
          plannedDateText: `<<ERR:Invalid JSON payload (${detail})>>`,
          dueDateText: `<<ERR:Invalid JSON payload (${detail})>>`,
          projectName: null,
          omniFocusTaskUrl: null,
          missing: false
        };
      }

      if (payload.error) {
        return {
          id,
          completed: false,
          plannedEpochSeconds: null,
          dueEpochSeconds: null,
          plannedDateText: `<<ERR:${payload.error}>>`,
          dueDateText: `<<ERR:${payload.error}>>`,
          projectName: null,
          omniFocusTaskUrl: null,
          missing: false
        };
      }

      const plannedRaw = typeof payload.plannedDate === "string" ? payload.plannedDate : null;
      const dueRaw = typeof payload.dueDate === "string" ? payload.dueDate : null;
      const projectNameRaw = typeof payload.projectName === "string" ? payload.projectName : null;
      const taskUrlRaw = typeof payload.taskUrl === "string" ? payload.taskUrl : null;

      return {
        id,
        completed: Boolean(payload.completed),
        plannedEpochSeconds: parseEpochSeconds(plannedRaw ?? undefined),
        dueEpochSeconds: parseEpochSeconds(dueRaw ?? undefined),
        plannedDateText: plannedRaw,
        dueDateText: dueRaw,
        projectName: projectNameRaw,
        omniFocusTaskUrl: taskUrlRaw,
        missing: Boolean(payload.missing)
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

  if (task.plannedEpochSeconds !== null) {
    lines.push(`${indent}set planned date of ${variableName} to (date "${formatEpochForAppleScriptDate(task.plannedEpochSeconds)}")`);
  }

  if (task.dueEpochSeconds !== null) {
    lines.push(`${indent}set due date of ${variableName} to (current date)`);
    lines.push(`${indent}set day of (due date of ${variableName}) to day of (date "${formatEpochForAppleScriptDate(task.dueEpochSeconds)}")`);
    lines.push(`${indent}set month of (due date of ${variableName}) to month of (date "${formatEpochForAppleScriptDate(task.dueEpochSeconds)}")`);
    lines.push(`${indent}set year of (due date of ${variableName}) to year of (date "${formatEpochForAppleScriptDate(task.dueEpochSeconds)}")`);
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

function parseEpochSeconds(input: string | undefined): number | null {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      return null;
    }

    return parsed;
  }

  return parseDateTokenToEpochSeconds(trimmed);
}

function extractInlineFieldValue(input: string, fieldName: "planned" | "due"): string | null {
  const pattern = new RegExp(`(?:^|\\s)${fieldName}::([^\\s]+)`, "i");
  const match = input.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function removeInlineDateFields(input: string): string {
  const withoutPlanned = input.replace(/(^|\s)planned::[^\s]+/gi, "$1");
  const withoutDue = withoutPlanned.replace(/(^|\s)due::[^\s]+/gi, "$1");
  const withoutProject = withoutDue.replace(/(^|\s)project::(?:"[^"]*"|[^\s]+)/gi, "$1");
  const withoutLegacyOfField = withoutProject.replace(/(^|\s)OF::(?:"[^"]*"|[^\s]+)/gi, "$1");
  const withoutOfLink = withoutLegacyOfField.replace(/\s*\[OF\]\([^\)]+\)/gi, "");
  return withoutOfLink.replace(/\s{2,}/g, " ").trim();
}

function setInlineFieldValue(input: string, fieldName: "planned" | "due" | "project", value: string | null): string {
  const stripped = input
    .replace(new RegExp(`(^|\\s)${fieldName}::(?:\"[^\"]*\"|[^\\s]+)`, "gi"), "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!value) {
    return stripped;
  }

  const encodedValue = /\s/.test(value) ? `"${value.replace(/"/g, "'")}"` : value;
  return stripped.length > 0 ? `${stripped} ${fieldName}::${encodedValue}` : `${fieldName}::${encodedValue}`;
}

function setOmniFocusLinkValue(input: string, url: string | null): string {
  const stripped = input
    .replace(/(^|\s)OF::(?:\"[^\"]*\"|[^\s]+)/gi, "$1")
    .replace(/\s*\[OF\]\([^\)]+\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!url) {
    return stripped;
  }

  const link = `[OF](${url})`;
  return stripped.length > 0 ? `${stripped} ${link}` : link;
}

function normalizeProjectValueForObsidian(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOmniFocusTaskUrlForObsidian(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("<<ERR:")) {
    return null;
  }

  return trimmed;
}

function parseDateTokenToEpochSeconds(token: string | null): number | null {
  if (!token) {
    return null;
  }

  const trimmed = token.trim();
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const year = Number.parseInt(dateOnlyMatch[1], 10);
    const month = Number.parseInt(dateOnlyMatch[2], 10) - 1;
    const day = Number.parseInt(dateOnlyMatch[3], 10);
    const localDate = new Date(year, month, day, 0, 0, 0, 0);
    if (Number.isNaN(localDate.getTime())) {
      return null;
    }

    return Math.floor(localDate.getTime() / 1000);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return Math.floor(parsed.getTime() / 1000);
}

function formatEpochForObsidian(epochSeconds: number | null): string | null {
  if (!Number.isFinite(epochSeconds ?? null)) {
    return null;
  }

  const date = new Date((epochSeconds as number) * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = date.getSeconds();

  if (hour === "00" && minute === "00" && second === 0) {
    return `${year}-${month}-${day}`;
  }

  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function formatEpochForAppleScriptDate(epochSeconds: number | null): string {
  const date = new Date((epochSeconds ?? 0) * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeOmniDateTextForObsidian(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("<<ERR:")) {
    return null;
  }

  const isoDatePrefix = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDatePrefix) {
    return isoDatePrefix[1];
  }

  const parsedEpoch = parseDateTokenToEpochSeconds(trimmed);
  if (parsedEpoch === null) {
    return null;
  }

  const formatted = formatEpochForObsidian(parsedEpoch);
  if (!formatted) {
    return null;
  }

  return formatted.slice(0, 10);
}

function normalizeEpochSeconds(value: number | null | undefined): number | null {
  if (!Number.isFinite(value ?? null)) {
    return null;
  }

  return Math.round(value as number);
}

function areEpochValuesEqual(left: number | null, right: number | null): boolean {
  return left === right;
}

function hasAnyScheduleValue(plannedEpochSeconds: number | null, dueEpochSeconds: number | null): boolean {
  return plannedEpochSeconds !== null || dueEpochSeconds !== null;
}

function hasRecordScheduleBaseline(record: ExportRecord): boolean {
  return Object.prototype.hasOwnProperty.call(record, "plannedEpochSeconds")
    || Object.prototype.hasOwnProperty.call(record, "dueEpochSeconds");
}

async function setOmniFocusTaskScheduling(taskId: string, plannedEpochSeconds: number | null, dueEpochSeconds: number | null): Promise<void> {
  const script = [
    "on run argv",
    "set targetId to item 1 of argv",
    "set plannedArg to item 2 of argv",
    "set dueArg to item 3 of argv",
    "tell application \"OmniFocus\"",
    "set jsCode to \"(() => {\" & linefeed & ¬",
    "\"  const taskID = \" & quoted form of targetId & \";\" & linefeed & ¬",
    "\"  const plannedArg = \" & quoted form of plannedArg & \";\" & linefeed & ¬",
    "\"  const dueArg = \" & quoted form of dueArg & \";\" & linefeed & ¬",
    "\"  const task = Task.byIdentifier(taskID);\" & linefeed & ¬",
    "\"  if (!task) { throw new Error('Task not found: ' + taskID); }\" & linefeed & ¬",
    "\"  task.plannedDate = plannedArg ? new Date(plannedArg) : null;\" & linefeed & ¬",
    "\"  task.dueDate = dueArg ? new Date(dueArg) : null;\" & linefeed & ¬",
    "\"  return 'ok';\" & linefeed & ¬",
    "\"})();\"",
    "return evaluate javascript jsCode",
    "end tell",
    "end run"
  ].join("\n");

  await runAppleScript(script, [taskId, plannedEpochSeconds === null ? "" : formatEpochForAppleScriptDate(plannedEpochSeconds), dueEpochSeconds === null ? "" : formatEpochForAppleScriptDate(dueEpochSeconds)]);
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

    new Setting(containerEl)
      .setName("Enable sync log")
      .setDesc("Create a Synkerrors file in the vault root after each sync. Disable to suppress log files.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableSyncLog).onChange(async (value) => {
          this.plugin.settings.enableSyncLog = value;
          await this.plugin.savePluginData();
        });
      });

    new Setting(containerEl)
      .setName("Automatic full sync interval (minutes)")
      .setDesc("Set to 0 to disable. Example: 10 runs full sync every 10 minutes.")
      .addText((text) => {
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.autoFullSyncIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.autoFullSyncIntervalMinutes = Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
            await this.plugin.savePluginData();
            this.plugin.configureAutoFullSync();
          });
      });

    new Setting(containerEl)
      .setName("LM Studio base URL")
      .setDesc("OpenAI-compatible LM Studio URL for AI note analysis.")
      .addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:1234")
          .setValue(this.plugin.settings.lmStudioBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.lmStudioBaseUrl = value.trim();
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("LM Studio model")
      .setDesc("Model name sent to LM Studio /v1/chat/completions.")
      .addText((text) => {
        text
          .setPlaceholder("local-model")
          .setValue(this.plugin.settings.lmStudioModel)
          .onChange(async (value) => {
            this.plugin.settings.lmStudioModel = value.trim() || "local-model";
            await this.plugin.savePluginData();
          });
      });
  }
}