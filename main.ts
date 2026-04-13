import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  moment,
  requestUrl,
} from "obsidian";

interface GetNoteSyncSettings {
  apiBaseUrl: string;
  listPath: string;
  detailPath: string;
  apiKey: string;
  clientId: string;
  targetFolder: string;
  sproutFolder: string;
  topicFolder: string;
  createDateSubfolders: boolean;
  dateFolderFormat: string;
  pollIntervalMinutes: number;
  autoSyncOnStartup: boolean;
  onlyImportMatchingFilters: boolean;
  allowedSources: string;
  allowedNoteTypes: string;
  syncSproutReports: boolean;
  includeRawJson: boolean;
  preserveOriginalTranscript: boolean;
  collapseOriginalTranscript: boolean;
  syncBodyFieldNames: string;
  syncSummaryFieldNames: string;
  lastSinceId: string;
  importedNotes: Record<string, string>;
  noteFingerprints: Record<string, string>;
  deletedNoteIds: string[];
}

const DEFAULT_SETTINGS: GetNoteSyncSettings = {
  apiBaseUrl: "https://openapi.biji.com",
  listPath: "/open/api/v1/resource/note/list",
  detailPath: "/open/api/v1/resource/note/detail",
  apiKey: "",
  clientId: "",
  targetFolder: "GetNote Inbox",
  sproutFolder: "GetNote Inbox",
  topicFolder: "主题",
  createDateSubfolders: true,
  dateFolderFormat: "YYYY/MM-DD",
  pollIntervalMinutes: 10,
  autoSyncOnStartup: false,
  onlyImportMatchingFilters: false,
  allowedSources: "record,audio,recorder,getseed,device,bluetooth",
  allowedNoteTypes: "audio,voice,transcript,record",
  syncSproutReports: true,
  includeRawJson: false,
  preserveOriginalTranscript: true,
  collapseOriginalTranscript: true,
  syncBodyFieldNames: "markdown,content,body,text,transcript,transcription,note_content",
  syncSummaryFieldNames: "summary,abstract,ai_summary,digest",
  lastSinceId: "0",
  importedNotes: {},
  noteFingerprints: {},
  deletedNoteIds: [],
};

type JsonRecord = Record<string, unknown>;
interface RenderContext {
  relatedSourcePath?: string | null;
  topicTags?: string[];
}

interface LicenseState {
  deviceId: string;
  rawLicense: string | null;
  isValid: boolean;
  statusText: string;
  expiresAt: string | null;
}

interface SignedLicensePayload {
  deviceId?: string;
  deviceIds?: string[];
  exp: string;
  customer?: string;
  unlimitedDevices?: boolean;
}

const DEVICE_ID_SECRET_ID = "getnote-sync-device-id";
const LICENSE_SECRET_ID = "getnote-sync-license";
const LICENSE_PREFIX = "gns1";
const LEGACY_LICENSE_SALT = "getnote-sync-local-license-v1";
const LEGACY_LICENSE_CHECKSUM_LENGTH = 24;
const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv72AJyy7bY1jLRKznwH9
J67zCLYWyO+o323QZ2gpUvbPtrcbpgsSealUOkAGR3wEr4QQDqdXMF1QO/2trOzn
Ju9doRms2lasGkZuRJJzb8jKcgvOcWwSr05s3TSc609E4ij7906OG86xbFTHTPxi
XgQwf/5HRD9xz4JJUsoqvmz4lAwMzPYyu8UT0Gv8Ncz1u1xTckfdD3tnzMOwep/d
j1BuYjSKXVzRONkuwFL7ac36WpbV/re6BbxjV9jk58BQwsu+jmHIX5laTsc771aC
RvuLit6sAzAKmiODR04aqujPcQOieCNz9lFz5xUZ9Ch8Lh3DGGeUbSvsP3s3eIfP
PQIDAQAB
-----END PUBLIC KEY-----`;

export default class GetNoteSyncPlugin extends Plugin {
  settings: GetNoteSyncSettings;
  private syncTimer: number | null = null;
  private isSyncing = false;
  private detailCache = new Map<string, JsonRecord | null>();
  private licenseState: LicenseState | null = null;

  async onload() {
    await this.loadSettings();
    await this.refreshLicenseState();

    this.addCommand({
      id: "sync-getnote-now",
      name: "立即同步 Get笔记 转写",
      callback: async () => {
        await this.runSync(true);
      },
    });

    this.addCommand({
      id: "reset-getnote-since-id",
      name: "重置 Get笔记 同步游标",
      callback: async () => {
        this.settings.lastSinceId = "0";
        this.settings.importedNotes = {};
        this.settings.noteFingerprints = {};
        this.settings.deletedNoteIds = [];
        await this.saveSettings();
        new Notice("GetNote Sync 同步游标已重置。");
      },
    });

    this.addCommand({
      id: "clear-getnote-deleted-history",
      name: "清空 Get笔记 已删除记录",
      callback: async () => {
        this.settings.deletedNoteIds = [];
        await this.saveSettings();
        new Notice("GetNote Sync 已删除记录已清空。");
      },
    });

    this.addCommand({
      id: "refresh-imported-getnote-notes",
      name: "刷新已导入 Get笔记 笔记",
      callback: async () => {
        await this.refreshImportedNotes(true);
      },
    });

    this.addRibbonIcon("audio-lines", "Sync Get笔记", async () => {
      await this.runSync(true);
    });

    this.addSettingTab(new GetNoteSyncSettingTab(this.app, this));
    this.restartAutoSync();

    if (this.settings.autoSyncOnStartup) {
      void this.runSync(false);
    }
  }

  onunload() {
    this.stopAutoSync();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.deletedNoteIds = uniqueStrings(this.settings.deletedNoteIds ?? []);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.restartAutoSync();
  }

  private restartAutoSync() {
    this.stopAutoSync();

    if (this.settings.pollIntervalMinutes <= 0) {
      return;
    }

    const intervalMs = this.settings.pollIntervalMinutes * 60 * 1000;
    this.syncTimer = window.setInterval(() => {
      void this.runSync(false);
    }, intervalMs);
  }

  private stopAutoSync() {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async runSync(showNotice: boolean) {
    if (!(await this.ensureLicensed(showNotice))) {
      return;
    }

    if (this.isSyncing) {
      if (showNotice) {
        new Notice("GetNote Sync is already running.");
      }
      return;
    }

    if (!this.settings.apiKey || !this.settings.clientId) {
      new Notice("Please set your Get笔记 Client ID and API Key first.");
      return;
    }

    this.isSyncing = true;

    try {
      const reconciled = await this.reconcileDeletedNotes();
      if (reconciled) {
        await this.saveData(this.settings);
      }

      await this.ensureFolder(this.settings.targetFolder);
      const notes = await this.fetchNotes(this.settings.lastSinceId || "0");

      if (notes.length === 0) {
        if (showNotice) {
          new Notice("没有发现新的 Get笔记内容。");
        }
        return;
      }

      let imported = 0;
      let latestSinceId = this.settings.lastSinceId;

      for (const note of notes) {
        const noteId = extractNoteId(note);
        if (!noteId) {
          continue;
        }

        if (!this.shouldImportNote(note, noteId)) {
          latestSinceId = maxNumericString(latestSinceId, noteId);
          continue;
        }

        latestSinceId = maxNumericString(latestSinceId, noteId);
        if (this.canSkipNoteUpdate(note, noteId)) {
          continue;
        }
        const changed = await this.createOrUpdateMarkdown(note, noteId);
        if (changed) {
          imported += 1;
        }
      }

      this.settings.lastSinceId = latestSinceId;
      await this.saveData(this.settings);

      if (showNotice) {
        new Notice(`GetNote Sync 已完成，本次导入或更新 ${imported} 条笔记。`);
      }
    } catch (error) {
      console.error("GetNote Sync failed", error);
      new Notice(`GetNote Sync 同步失败：${getErrorMessage(error)}`);
    } finally {
      this.isSyncing = false;
    }
  }

  async refreshImportedNotes(showNotice: boolean) {
    if (!(await this.ensureLicensed(showNotice))) {
      return;
    }

    if (this.isSyncing) {
      if (showNotice) {
        new Notice("GetNote Sync is already running.");
      }
      return;
    }

    if (!this.settings.apiKey || !this.settings.clientId) {
      new Notice("Please set your Get笔记 Client ID and API Key first.");
      return;
    }

    const importedIds = Object.entries(this.settings.importedNotes)
      .filter(([, path]) => this.app.vault.getAbstractFileByPath(path) instanceof TFile)
      .map(([noteId]) => noteId);
    if (importedIds.length === 0) {
      if (showNotice) {
        new Notice("当前没有已导入的 Get笔记 可刷新。");
      }
      return;
    }

    this.isSyncing = true;

    try {
      const refreshSinceId = decrementNumericString(minNumericString(importedIds) ?? "0");
      const notes = await this.fetchNotes(refreshSinceId);

      const noteMap = new Map<string, JsonRecord>();
      for (const note of notes) {
        const noteId = extractNoteId(note);
        if (!noteId) {
          continue;
        }
        noteMap.set(noteId, note);
      }

      let refreshed = 0;
      for (const noteId of importedIds) {
        const note = noteMap.get(noteId);
        if (!note || !this.shouldImportNote(note, noteId)) {
          continue;
        }

        if (this.canSkipNoteUpdate(note, noteId)) {
          continue;
        }
        const changed = await this.createOrUpdateMarkdown(note, noteId);
        if (changed) {
          refreshed += 1;
        }
      }

      await this.saveData(this.settings);

      if (showNotice) {
        new Notice(`GetNote Sync 已刷新 ${refreshed} 条已导入笔记。`);
      }
    } catch (error) {
      console.error("GetNote Sync refresh failed", error);
      new Notice(`GetNote Sync 刷新失败：${getErrorMessage(error)}`);
    } finally {
      this.isSyncing = false;
    }
  }

  private async fetchNotes(sinceId: string): Promise<JsonRecord[]> {
    const url = new URL(this.settings.listPath, ensureTrailingSlash(this.settings.apiBaseUrl));
    url.searchParams.set("since_id", sinceId || "0");

    const response = await requestUrl({
      url: url.toString(),
      method: "GET",
      headers: {
        Authorization: this.settings.apiKey,
        "X-Client-ID": this.settings.clientId,
      },
    });

    const payload = response.json;
    return parseNotes(payload).sort((left, right) => {
      const leftId = extractNoteId(left) ?? "0";
      const rightId = extractNoteId(right) ?? "0";
      return compareNumericStrings(leftId, rightId);
    });
  }

  private async createOrUpdateMarkdown(note: JsonRecord, noteId: string): Promise<boolean> {
    const rawTitle = extractTitle(note) ?? `GetNote ${noteId}`;
    const title = this.formatDisplayTitle(note, rawTitle);
    const relativePath = this.buildTargetPath(note, noteId, title);
    const existingPath = this.settings.importedNotes[noteId];
    const currentPath = existingPath ?? relativePath;

    let file = this.app.vault.getAbstractFileByPath(currentPath);
    let currentContent: string | null = null;

    if (file instanceof TFile) {
      if (currentPath !== relativePath) {
        await this.ensureFolder(parentFolderOf(relativePath));
        await this.app.fileManager.renameFile(file, relativePath);
        this.settings.importedNotes[noteId] = relativePath;
        file = this.app.vault.getAbstractFileByPath(relativePath);
      }

      if (!(file instanceof TFile)) {
        return false;
      }
      currentContent = await this.app.vault.cachedRead(file);
    }

    const renderNote = await this.enrichNoteForRender(
      note,
      currentContent ? Boolean(readSection(currentContent, "原始转写")) : false,
    );
    const relatedSourcePath = this.isSproutReport(note) ? await this.findRelatedSourcePath(note) : null;
    const topicTags = uniqueStrings(this.isSproutReport(note)
      ? await this.getSproutTopicTags(note, relatedSourcePath)
      : extractTopicTags(note));
    const markdown = this.renderMarkdown(renderNote, noteId, title, {
      relatedSourcePath,
      topicTags,
    });

    if (file instanceof TFile) {
      const existingContent = currentContent ?? await this.app.vault.cachedRead(file);
      const nextMarkdown = preserveExistingOriginalTranscript(markdown, existingContent);
      if (existingContent === nextMarkdown) {
        await this.syncRelationships(renderNote, relativePath, relatedSourcePath, topicTags);
        return false;
      }

      await this.app.vault.modify(file, nextMarkdown);
      this.settings.importedNotes[noteId] = relativePath;
      this.settings.noteFingerprints[noteId] = computeNoteFingerprint(note);
      await this.syncRelationships(renderNote, relativePath, relatedSourcePath, topicTags);
      return true;
    }

    if (existingPath && existingPath !== relativePath) {
      file = this.app.vault.getAbstractFileByPath(relativePath);
    }

    if (file instanceof TFile) {
      const existingContent = await this.app.vault.cachedRead(file);
      const nextMarkdown = preserveExistingOriginalTranscript(markdown, existingContent);
      await this.app.vault.modify(file, nextMarkdown);
      this.settings.importedNotes[noteId] = relativePath;
      this.settings.noteFingerprints[noteId] = computeNoteFingerprint(note);
      await this.syncRelationships(renderNote, relativePath, relatedSourcePath, topicTags);
      return true;
    }

    await this.ensureFolder(parentFolderOf(relativePath));
    await this.app.vault.create(relativePath, markdown);
    this.settings.importedNotes[noteId] = relativePath;
    this.settings.noteFingerprints[noteId] = computeNoteFingerprint(note);
    await this.syncRelationships(renderNote, relativePath, relatedSourcePath, topicTags);
    return true;
  }

  private shouldImportNote(note: JsonRecord, noteId?: string): boolean {
    if (noteId && this.settings.deletedNoteIds.includes(noteId)) {
      return false;
    }

    if (this.isSproutReport(note)) {
      return this.settings.syncSproutReports;
    }

    if (!this.settings.onlyImportMatchingFilters) {
      return true;
    }

    const source = (pickFirstString(note, ["source"]) ?? "").toLowerCase();
    const noteType = (pickFirstString(note, ["note_type", "type"]) ?? "").toLowerCase();
    const sourceRules = csvToKeys(this.settings.allowedSources).map((item) => item.toLowerCase());
    const typeRules = csvToKeys(this.settings.allowedNoteTypes).map((item) => item.toLowerCase());

    const sourceMatched = sourceRules.length === 0 || matchesAnyRule(source, sourceRules);
    const typeMatched = typeRules.length === 0 || matchesAnyRule(noteType, typeRules);

    return sourceMatched || typeMatched;
  }

  private buildTargetPath(note: JsonRecord, noteId: string, title: string): string {
    const dateFolder = this.settings.createDateSubfolders
      ? this.formatDateFolder(extractDate(note))
      : "";

    const baseFolder = this.settings.targetFolder;

    const folderPath = normalizePath(
      [baseFolder, dateFolder].filter(Boolean).join("/"),
    );

    return normalizePath(`${folderPath}/${sanitizeFileName(title)}-${noteId}.md`);
  }

  private isSproutReport(note: JsonRecord): boolean {
    return isSproutReportNote(note);
  }

  private formatDisplayTitle(note: JsonRecord, title: string): string {
    if (!this.isSproutReport(note)) {
      return title;
    }

    return title.startsWith("[发芽] ") ? title : `[发芽] ${title}`;
  }

  private formatDateFolder(dateString: string | null): string {
    if (!dateString) {
      return "unknown-date";
    }

    const parsed = moment(dateString);
    if (!parsed.isValid()) {
      return "unknown-date";
    }

    return parsed.format(this.settings.dateFolderFormat || DEFAULT_SETTINGS.dateFolderFormat);
  }

  private async syncRelationships(
    note: JsonRecord,
    currentPath: string,
    relatedSourcePath: string | null,
    topicTags: string[],
  ) {
    await this.ensureTopicSection(currentPath, topicTags);

    if (this.isSproutReport(note) && relatedSourcePath) {
      await this.ensureSproutBacklink(currentPath, relatedSourcePath, topicTags);
      await this.ensureSourceSproutLink(relatedSourcePath, currentPath);
      return;
    }

    if (!this.isSproutReport(note)) {
      await this.ensureSproutStatusSection(currentPath);
    }
  }

  private async enrichNoteForRender(note: JsonRecord, hasExistingOriginalTranscript = false): Promise<JsonRecord> {
    if (!this.shouldFetchDetailForNote(note, hasExistingOriginalTranscript)) {
      return note;
    }

    const detailId = pickFirstString(note, ["note_id", "id"]);
    if (!detailId) {
      return note;
    }

    const detailCacheKey = `${detailId}::${computeNoteFingerprint(note)}`;

    if (this.detailCache.has(detailCacheKey)) {
      const cached = this.detailCache.get(detailCacheKey);
      return cached ? { ...note, ...cached } : note;
    }

    try {
      const url = new URL(this.settings.detailPath, ensureTrailingSlash(this.settings.apiBaseUrl));
      url.searchParams.set("id", detailId);

      const response = await requestUrl({
        url: url.toString(),
        method: "GET",
        headers: {
          Authorization: this.settings.apiKey,
          "X-Client-ID": this.settings.clientId,
        },
      });

      const payload = response.json;
      const detailNote = parseDetailNote(payload);
      this.detailCache.set(detailCacheKey, detailNote);
      this.trimDetailCache();
      return detailNote ? { ...note, ...detailNote } : note;
    } catch (error) {
      console.warn("GetNote Sync detail fetch failed", detailId, error);
      this.detailCache.set(detailCacheKey, null);
      this.trimDetailCache();
      return note;
    }
  }

  private async findRelatedSourcePath(note: JsonRecord): Promise<string | null> {
    const sproutCreatedAt = extractDate(note);
    if (!sproutCreatedAt) {
      return null;
    }

    let bestMatch: { path: string; diff: number } | null = null;
    const candidatePaths = uniqueStrings([
      ...Object.values(this.settings.importedNotes),
      ...this.app.vault
        .getMarkdownFiles()
        .map((file) => file.path)
        .filter((path) => path.startsWith(normalizePath(this.settings.targetFolder))),
    ]);

    for (const path of candidatePaths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        continue;
      }

      const content = await this.app.vault.cachedRead(file);
      const created = readFrontmatterValue(content, "created");
      const tags = readFrontmatterList(content, "tags");
      const isSproutFile = tags.includes("sprout-report") || file.basename.startsWith("[发芽] ");

      if (isSproutFile || !created) {
        continue;
      }

      const diff = moment(sproutCreatedAt).diff(moment(created), "seconds");
      if (diff < 0 || diff > 60 * 60 * 24) {
        continue;
      }

      if (!bestMatch || diff < bestMatch.diff) {
        bestMatch = { path: file.path, diff };
      }
    }

    return bestMatch?.path ?? null;
  }

  private async getSproutTopicTags(note: JsonRecord, relatedSourcePath: string | null): Promise<string[]> {
    const ownTopics = extractTopicTags(note);
    if (ownTopics.length > 0) {
      return ownTopics;
    }

    if (!relatedSourcePath) {
      return [];
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(relatedSourcePath);
    if (!(sourceFile instanceof TFile)) {
      return [];
    }

    const content = await this.app.vault.cachedRead(sourceFile);
    return readFrontmatterList(content, "topics");
  }

  private async ensureSproutBacklink(sproutPath: string, sourcePath: string, topicTags: string[]) {
    const file = this.app.vault.getAbstractFileByPath(sproutPath);
    if (!(file instanceof TFile)) {
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const topicsSection = topicTags.length > 0 ? renderTopicList(topicTags) : "";
    let updated = updateNamedSection(content, "来源笔记", `- [[${pathToWikiTarget(sourcePath)}]]`);

    if (topicsSection) {
      updated = updateNamedSection(updated, "主题", topicsSection);
    }

    if (updated !== content) {
      await this.app.vault.modify(file, updated);
    }
  }

  private async ensureSourceSproutLink(sourcePath: string, sproutPath: string) {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) {
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const existing = readSection(content, "发芽报告");
    const linkLine = `- [[${pathToWikiTarget(sproutPath)}]]`;
    const lines = existing ? existing.split("\n").map((line) => line.trim()).filter(Boolean) : [];

    if (!hasNormalizedLine(lines, linkLine)) {
      lines.push(linkLine);
    }

    const updated = updateNamedSection(content, "发芽报告", dedupeSectionLines(lines).join("\n"));
    const withStatus = updateNamedSection(
      updated,
      "发芽状态",
      [
        "> [!success] 发芽状态",
        `> 已同步 ${dedupeSectionLines(lines).length} 条发芽笔记。`,
      ].join("\n"),
    );

    if (withStatus !== content) {
      await this.app.vault.modify(file, withStatus);
    }

    await this.clearSproutReminder(sourcePath);
  }

  private async ensureTopicSection(path: string, topicTags: string[]) {
    if (topicTags.length === 0) {
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const frontmatterTopics = readFrontmatterList(content, "topics");
    const finalTopics = frontmatterTopics.length > 0 ? frontmatterTopics : topicTags;
    const tags = readFrontmatterList(content, "tags");
    const heading = tags.includes("sprout-report") ? "主题" : "讨论主题";
    const updated = updateNamedSection(content, heading, renderTopicList(finalTopics));
    if (updated !== content) {
      await this.app.vault.modify(file, updated);
    }
  }

  private async ensureSproutStatusSection(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const hasSproutSection = Boolean(readSection(content, "发芽报告"));
    const tags = readFrontmatterList(content, "tags");
    if (hasSproutSection || tags.includes("sprout-report")) {
      const cleared = removeNamedSection(removeNamedSection(content, "发芽提示"), "发芽状态");
      if (cleared !== content) {
        await this.app.vault.modify(file, cleared);
      }
      return;
    }

    const reminder = [
      "> [!tip] 发芽状态",
      "> 当前还没有同步到对应的发芽笔记。",
      "> 如果你已经在 Get App 里生成了发芽报告，请先点一次“保存到笔记”，再等待插件自动同步。",
    ].join("\n");

    const updated = updateNamedSection(removeNamedSection(content, "发芽提示"), "发芽状态", reminder);
    if (updated !== content) {
      await this.app.vault.modify(file, updated);
    }
  }

  private async clearSproutReminder(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const updated = removeNamedSection(removeNamedSection(content, "发芽提示"), "发芽状态");
    if (updated !== content) {
      await this.app.vault.modify(file, updated);
    }
  }

  private renderMarkdown(note: JsonRecord, noteId: string, title: string, context: RenderContext = {}): string {
    const createdAt = extractDate(note);
    const body = pickFirstString(note, csvToKeys(this.settings.syncBodyFieldNames));
    const summary = pickFirstString(note, csvToKeys(this.settings.syncSummaryFieldNames));
    const speakerText = extractSpeakerText(note);
    const audioOriginal = pickFirstString(note, ["audio.original", "audio_original"]);
    const tags = extractTagNames(note);
    const isSprout = this.isSproutReport(note);
    const topicTags = context.topicTags ?? extractTopicTags(note);
    const rawJson = JSON.stringify(note, null, 2);
    const mainText = body ?? speakerText ?? "";
    const structuredSections = extractStructuredSections(mainText);
    const extractedSummary = structuredSections.summary;
    const extractedChapters = structuredSections.chapters;
    const extractedQuotes = structuredSections.quotes;
    const extractedTodos = structuredSections.todos;
    const cleanedBody = structuredSections.hasStructuredSections
      ? stripKnownSections(mainText, structuredSections.headings)
      : mainText;
    const finalSummary = summary ?? extractedSummary;
    const originalTranscript = !isSprout
      ? normalizeSectionValue(audioOriginal ?? speakerText ?? "")
      : null;

    const frontmatter = [
      "---",
      `title: "${escapeYamlString(title)}"`,
      createdAt ? `created: "${createdAt}"` : undefined,
      ...(topicTags.length > 0 ? ["topics:", ...topicTags.map((tag) => `  - "${escapeYamlString(tag)}"`)] : []),
      "tags:",
      "  - getnote",
      `  - ${isSprout ? "sprout-report" : "transcript"}`,
      ...tags.map((tag) => `  - ${escapeYamlString(tag)}`),
      "---",
    ]
      .filter(Boolean)
      .join("\n");

    const sections = isSprout
      ? [
        `# ${title}`,
        createdAt ? `> 导入时间：${createdAt}` : undefined,
        "> 这是一条 Get笔记 发芽报告",
        context.relatedSourcePath ? `## 来源笔记\n\n- [[${pathToWikiTarget(context.relatedSourcePath)}]]` : undefined,
        !structuredSections.hasStructuredSections && cleanedBody ? `## 全文\n\n${cleanedBody}` : undefined,
        extractedChapters ? `## 章节概要\n\n${extractedChapters}` : undefined,
        extractedQuotes ? `## 金句\n\n${extractedQuotes}` : undefined,
        topicTags.length > 0 ? `## 主题\n\n${renderTopicList(topicTags)}` : undefined,
        this.settings.includeRawJson ? "## 原始 JSON\n\n```json\n" + rawJson + "\n```" : undefined,
      ]
      : [
        `# ${title}`,
        createdAt ? `> 导入时间：${createdAt}` : undefined,
        renderMeetingOverview(createdAt, topicTags),
        finalSummary ? `## 会议摘要\n\n${finalSummary}` : undefined,
        topicTags.length > 0 ? `## 讨论主题\n\n${renderTopicList(topicTags)}` : undefined,
        `## 行动项\n\n${normalizeTodoSection(extractedTodos ?? "无")}`,
        extractedChapters
          ? `## 讨论过程\n\n${extractedChapters}`
          : (!structuredSections.hasStructuredSections && cleanedBody ? `## 讨论过程\n\n${cleanedBody}` : undefined),
        extractedQuotes ? `## 金句\n\n${extractedQuotes}` : undefined,
        this.settings.preserveOriginalTranscript && originalTranscript
          ? renderOriginalTranscriptSection(originalTranscript, this.settings.collapseOriginalTranscript)
          : undefined,
        this.settings.includeRawJson ? "## 原始 JSON\n\n```json\n" + rawJson + "\n```" : undefined,
      ]
      .filter(Boolean)
      .join("\n\n");

    return `${frontmatter}\n\n${sections}\n`;
  }

  private async ensureFolder(path: string) {
    if (!path || path === "." || path === "/") {
      return;
    }

    const parts = normalizePath(path).split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async reconcileDeletedNotes(): Promise<boolean> {
    let changed = false;

    for (const [noteId, path] of Object.entries(this.settings.importedNotes)) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        continue;
      }

      delete this.settings.importedNotes[noteId];
      delete this.settings.noteFingerprints[noteId];
      if (!this.settings.deletedNoteIds.includes(noteId)) {
        this.settings.deletedNoteIds.push(noteId);
      }
      changed = true;
    }

    if (changed) {
      this.settings.deletedNoteIds = uniqueStrings(this.settings.deletedNoteIds);
    }

    return changed;
  }

  private canSkipNoteUpdate(note: JsonRecord, noteId: string): boolean {
    const path = this.settings.importedNotes[noteId];
    if (!path) {
      return false;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return false;
    }

    return this.settings.noteFingerprints[noteId] === computeNoteFingerprint(note);
  }

  async getLicenseState(): Promise<LicenseState> {
    return this.refreshLicenseState();
  }

  async saveLicense(rawLicense: string): Promise<LicenseState> {
    const normalized = rawLicense.trim();
    if (normalized) {
      this.app.secretStorage.setSecret(LICENSE_SECRET_ID, normalized);
    } else {
      this.app.secretStorage.setSecret(LICENSE_SECRET_ID, "");
    }
    return this.refreshLicenseState();
  }

  async clearLicense(): Promise<LicenseState> {
    this.app.secretStorage.setSecret(LICENSE_SECRET_ID, "");
    return this.refreshLicenseState();
  }

  private async ensureLicensed(showNotice: boolean): Promise<boolean> {
    const state = await this.refreshLicenseState();
    if (state.isValid) {
      return true;
    }

    if (showNotice) {
      new Notice(`GetNote Sync 未授权：${state.statusText}`);
    }
    return false;
  }

  private async refreshLicenseState(): Promise<LicenseState> {
    const deviceId = this.getOrCreateDeviceId();
    const rawLicense = normalizeLicenseValue(this.app.secretStorage.getSecret(LICENSE_SECRET_ID));
    const state = await validateLicense(deviceId, rawLicense);
    this.licenseState = state;
    return state;
  }

  private getOrCreateDeviceId(): string {
    const existing = normalizeLicenseValue(this.app.secretStorage.getSecret(DEVICE_ID_SECRET_ID));
    if (existing) {
      return existing;
    }

    const deviceId = createDeviceId();
    this.app.secretStorage.setSecret(DEVICE_ID_SECRET_ID, deviceId);
    return deviceId;
  }

  private trimDetailCache(maxEntries = 200): void {
    while (this.detailCache.size > maxEntries) {
      const oldestKey = this.detailCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.detailCache.delete(oldestKey);
    }
  }

  private shouldFetchDetailForNote(note: JsonRecord, hasExistingOriginalTranscript: boolean): boolean {
    if (this.isSproutReport(note) || !this.settings.preserveOriginalTranscript || hasExistingOriginalTranscript) {
      return false;
    }

    if (pickFirstString(note, ["audio.original", "audio_original"])) {
      return false;
    }

    const source = (pickFirstString(note, ["source"]) ?? "").toLowerCase();
    const noteType = (pickFirstString(note, ["note_type", "type"]) ?? "").toLowerCase();
    const entryType = (pickFirstString(note, ["entry_type"]) ?? "").toLowerCase();
    const tags = extractTagNames(note).map((tag) => tag.toLowerCase());

    if (isLikelyAudioLike(source) || isLikelyAudioLike(noteType) || isLikelyAudioLike(entryType)) {
      return true;
    }

    if (tags.some((tag) => isLikelyAudioLike(tag))) {
      return true;
    }

    if (isRecord(note.audio)) {
      return true;
    }

    const attachments = note.attachments;
    if (!Array.isArray(attachments)) {
      return false;
    }

    return attachments.some((attachment) => {
      if (!isRecord(attachment)) {
        return false;
      }

      const attachmentType = (pickFirstString(attachment, ["type", "mime_type", "mimeType", "kind"]) ?? "").toLowerCase();
      return attachmentType.startsWith("audio/") || isLikelyAudioLike(attachmentType);
    });
  }
}

class GetNoteSyncSettingTab extends PluginSettingTab {
  plugin: GetNoteSyncPlugin;

  constructor(app: App, plugin: GetNoteSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    void this.renderAsync();
  }

  private async renderAsync(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    const licenseState = await this.plugin.getLicenseState();

    containerEl.createEl("h2", { text: "GetNote Sync 设置" });

    containerEl.createEl("h3", { text: "授权" });

    new Setting(containerEl)
      .setName("设备机器码")
      .setDesc("把这串机器码发给你自己，用来生成授权码")
      .addText((text) => {
        text.setValue(licenseState.deviceId);
        text.inputEl.readOnly = true;
        text.inputEl.style.fontFamily = "var(--font-monospace)";
        text.inputEl.style.fontSize = "12px";
        text.inputEl.setAttr("spellcheck", "false");
        text.inputEl.addEventListener("click", () => text.inputEl.select());
      })
      .addButton((button) =>
        button.setButtonText("复制").onClick(async () => {
          const copied = await copyToClipboard(licenseState.deviceId);
          new Notice(copied ? "设备机器码已复制。" : "当前环境不支持自动复制，请手动复制设备机器码。");
        }),
      );

    new Setting(containerEl)
      .setName("授权状态")
      .setDesc(licenseState.isValid
        ? `已激活${licenseState.expiresAt ? `，到期时间：${licenseState.expiresAt}` : ""}`
        : licenseState.statusText);

    new Setting(containerEl)
      .setName("授权码")
      .setDesc("填入你签发的授权码；一条授权码可以绑定多台设备，正式发码建议用仓库里的 scripts/issue-license.mjs")
      .addText((text) =>
        text
          .setPlaceholder("gns1.payload.signature")
          .setValue(licenseState.rawLicense ?? "")
          .onChange(async (value) => {
            await this.plugin.saveLicense(value);
          }),
      )
      .addButton((button) =>
        button.setButtonText("验证").setCta().onClick(async () => {
          const nextState = await this.plugin.getLicenseState();
          new Notice(nextState.isValid ? "GetNote Sync 授权有效。" : `授权无效：${nextState.statusText}`);
          this.display();
        }),
      )
      .addButton((button) =>
        button.setButtonText("清空").onClick(async () => {
          await this.plugin.clearLicense();
          new Notice("GetNote Sync 授权码已清空。");
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("Get笔记开放平台中的 Client ID")
      .addText((text) =>
        text
          .setPlaceholder("Client ID")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Get笔记开放平台中的 API Key")
      .addText((text) =>
        text
          .setPlaceholder("API Key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API 基础地址")
      .setDesc("默认使用官方 OpenAPI 域名")
      .addText((text) =>
        text
          .setPlaceholder("https://openapi.biji.com")
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiBaseUrl = value.trim() || DEFAULT_SETTINGS.apiBaseUrl;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("列表接口路径")
      .setDesc("默认接口来自官方文档，可按实际 OpenAPI 文档调整")
      .addText((text) =>
        text
          .setPlaceholder("/open/api/v1/resource/note/list")
          .setValue(this.plugin.settings.listPath)
          .onChange(async (value) => {
            this.plugin.settings.listPath = value.trim() || DEFAULT_SETTINGS.listPath;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("详情接口路径")
      .setDesc("用于补拉录音详情里的原始转写，例如 audio.original")
      .addText((text) =>
        text
          .setPlaceholder("/open/api/v1/resource/note/detail")
          .setValue(this.plugin.settings.detailPath)
          .onChange(async (value) => {
            this.plugin.settings.detailPath = value.trim() || DEFAULT_SETTINGS.detailPath;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("同步目标文件夹")
      .setDesc("同步后的 Markdown 会写入这个目录")
      .addText((text) =>
        text
          .setPlaceholder("GetNote Inbox")
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (value) => {
            this.plugin.settings.targetFolder = value.trim() || DEFAULT_SETTINGS.targetFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("发芽笔记目录")
      .setDesc("发芽内容会和核心笔记放在同一目录；这里保留兼容旧配置")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.targetFolder)
          .setValue(this.plugin.settings.sproutFolder)
          .onChange(async (value) => {
            this.plugin.settings.sproutFolder = value.trim() || DEFAULT_SETTINGS.targetFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("主题文件夹（已停用）")
      .setDesc("主题索引页已关闭；这里仅保留兼容旧配置，不会再自动生成额外笔记")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.topicFolder)
          .setValue(this.plugin.settings.topicFolder)
          .onChange(async (value) => {
            this.plugin.settings.topicFolder = value.trim() || DEFAULT_SETTINGS.topicFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("按日期自动分文件夹")
      .setDesc("开启后会按笔记日期写入子目录，例如 2025/02-08")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.createDateSubfolders).onChange(async (value) => {
          this.plugin.settings.createDateSubfolders = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("日期文件夹格式")
      .setDesc("使用 moment 格式，例如 YYYY/MM-DD 或 YYYY-MM")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.dateFolderFormat)
          .setValue(this.plugin.settings.dateFolderFormat)
          .onChange(async (value) => {
            this.plugin.settings.dateFolderFormat = value.trim() || DEFAULT_SETTINGS.dateFolderFormat;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("自动轮询间隔（分钟）")
      .setDesc("设置为 0 可关闭自动轮询，只保留手动同步")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.pollIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.pollIntervalMinutes = Number.isFinite(parsed) ? parsed : 0;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("启动时自动同步")
      .setDesc("打开 Obsidian 后立即拉一次最新转写")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSyncOnStartup).onChange(async (value) => {
          this.plugin.settings.autoSyncOnStartup = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("只同步匹配筛选规则的笔记")
      .setDesc("建议录音卡场景开启；会按 source 或 note_type 关键词做过滤")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.onlyImportMatchingFilters).onChange(async (value) => {
          this.plugin.settings.onlyImportMatchingFilters = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("允许的 Source 关键词")
      .setDesc("逗号分隔，命中任一关键词就会导入，例如 record,audio,getseed")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.allowedSources)
          .setValue(this.plugin.settings.allowedSources)
          .onChange(async (value) => {
            this.plugin.settings.allowedSources = value.trim() || DEFAULT_SETTINGS.allowedSources;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("允许的 Note Type 关键词")
      .setDesc("逗号分隔，命中任一关键词就会导入，例如 audio,voice,transcript")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.allowedNoteTypes)
          .setValue(this.plugin.settings.allowedNoteTypes)
          .onChange(async (value) => {
            this.plugin.settings.allowedNoteTypes = value.trim() || DEFAULT_SETTINGS.allowedNoteTypes;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("同步发芽报告")
      .setDesc("开启后，Get笔记中新生成的发芽报告也会自动写入 Obsidian")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncSproutReports).onChange(async (value) => {
          this.plugin.settings.syncSproutReports = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("保留原始转写")
      .setDesc("在核心录音笔记里保留原始转写全文，方便后续核对和二次处理")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.preserveOriginalTranscript).onChange(async (value) => {
          this.plugin.settings.preserveOriginalTranscript = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("折叠原始转写")
      .setDesc("开启后，原始转写会以可折叠 callout 形式显示在笔记后部")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.collapseOriginalTranscript).onChange(async (value) => {
          this.plugin.settings.collapseOriginalTranscript = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("附带原始 JSON")
      .setDesc("默认关闭；仅在调试接口字段时建议打开")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeRawJson).onChange(async (value) => {
          this.plugin.settings.includeRawJson = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("正文候选字段")
      .setDesc("按逗号填写接口里可能承载正文/转写内容的字段名")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.syncBodyFieldNames)
          .setValue(this.plugin.settings.syncBodyFieldNames)
          .onChange(async (value) => {
            this.plugin.settings.syncBodyFieldNames = value.trim() || DEFAULT_SETTINGS.syncBodyFieldNames;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("摘要候选字段")
      .setDesc("按逗号填写接口里可能承载摘要内容的字段名")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.syncSummaryFieldNames)
          .setValue(this.plugin.settings.syncSummaryFieldNames)
          .onChange(async (value) => {
            this.plugin.settings.syncSummaryFieldNames = value.trim() || DEFAULT_SETTINGS.syncSummaryFieldNames;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("立即同步")
      .setDesc("保存配置后立刻测试一次同步")
      .addButton((button) =>
        button.setButtonText("Sync").setCta().onClick(async () => {
          await this.plugin.runSync(true);
        }),
      );

    new Setting(containerEl)
      .setName("刷新已导入笔记")
      .setDesc("按最新模板重写当前已经同步到 vault 的 Get笔记")
      .addButton((button) =>
        button.setButtonText("Refresh").onClick(async () => {
          await this.plugin.refreshImportedNotes(true);
        }),
      );

    new Setting(containerEl)
      .setName("重置同步游标")
      .setDesc("清空 since_id、已导入映射和已删除记录，下次会重新从头拉取")
      .addButton((button) =>
        button.setButtonText("Reset").onClick(async () => {
          this.plugin.settings.lastSinceId = "0";
          this.plugin.settings.importedNotes = {};
          this.plugin.settings.noteFingerprints = {};
          this.plugin.settings.deletedNoteIds = [];
          await this.plugin.saveSettings();
          new Notice("GetNote Sync 同步游标已重置。");
        }),
      );

    new Setting(containerEl)
      .setName("清空已删除记录")
      .setDesc("如果你想把手动删掉的同步笔记重新导回，可以先清空这份记录")
      .addButton((button) =>
        button.setButtonText("Clear").onClick(async () => {
          this.plugin.settings.deletedNoteIds = [];
          await this.plugin.saveSettings();
          new Notice("GetNote Sync 已删除记录已清空。");
        }),
      );
  }
}

function parseNotes(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }

  if (!isRecord(payload)) {
    return [];
  }

  const candidates = [
    payload.data,
    payload.list,
    payload.items,
    payload.notes,
    isRecord(payload.data) ? payload.data.list : undefined,
    isRecord(payload.data) ? payload.data.items : undefined,
    isRecord(payload.data) ? payload.data.notes : undefined,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }
  }

  return [];
}

function parseDetailNote(payload: unknown): JsonRecord | null {
  if (!isRecord(payload)) {
    return null;
  }

  const candidates = [
    payload.note,
    isRecord(payload.data) ? payload.data.note : undefined,
    payload.data,
  ];

  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      return candidate;
    }
  }

  return null;
}

function extractTitle(note: JsonRecord): string | null {
  return (
    pickFirstString(note, ["title", "name", "subject", "note_title"]) ??
    summarizeText(pickFirstString(note, ["summary", "abstract", "content", "body", "text"]), 48)
  );
}

function extractDate(note: JsonRecord): string | null {
  const raw = pickFirstString(note, [
    "created_at",
    "create_time",
    "createdAt",
    "updated_at",
    "update_time",
    "updatedAt",
  ]);

  if (!raw) {
    return null;
  }

  const timestamp = Number(raw);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const millis = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
    return moment(millis).format("YYYY-MM-DD HH:mm:ss");
  }

  return raw;
}

function extractNoteId(note: JsonRecord): string | null {
  const candidates = ["id", "note_id", "resource_id", "record_id"];
  for (const key of candidates) {
    const value = note[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function extractSpeakerText(note: JsonRecord): string | null {
  const speakers = note.speakers ?? note.utterances ?? note.segments;
  if (!Array.isArray(speakers)) {
    return null;
  }

  const lines = speakers
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }
      const speaker = pickFirstString(item, ["speaker", "speaker_name", "role"]) ?? "Speaker";
      const text = pickFirstString(item, ["text", "content", "body"]);
      if (!text) {
        return null;
      }
      return `**${speaker}**：${text}`;
    })
    .filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines.join("\n\n") : null;
}

function extractTagNames(note: JsonRecord): string[] {
  const tags = note.tags;
  if (!Array.isArray(tags)) {
    return [];
  }

  return tags
    .map((tag) => {
      if (typeof tag === "string") {
        return tag.trim();
      }
      if (isRecord(tag) && typeof tag.name === "string") {
        return tag.name.trim();
      }
      return "";
    })
    .filter(Boolean);
}

function computeNoteFingerprint(note: JsonRecord): string {
  const noteId = extractNoteId(note) ?? "";
  const noteKey = pickFirstString(note, ["note_id"]) ?? "";
  const title = extractTitle(note) ?? "";
  const created = extractDate(note) ?? "";
  const updated = pickFirstString(note, ["updated_at", "updatedAt", "update_time"]) ?? "";
  const source = pickFirstString(note, ["source"]) ?? "";
  const noteType = pickFirstString(note, ["note_type", "type"]) ?? "";
  const content = pickFirstString(note, ["content", "body", "text"]) ?? "";
  const tags = extractTagNames(note).join("|");

  return [noteId, noteKey, title, created, updated, source, noteType, content.length, tags].join("::");
}

function extractTopicTags(note: JsonRecord): string[] {
  const ignored = new Set(["录音卡笔记", "getnote", "transcript", "sprout-report"]);
  return extractTagNames(note).filter((tag) => !ignored.has(tag.toLowerCase()) && !ignored.has(tag));
}

function pickFirstString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = deepGet(record, key);
    const normalized = normalizeUnknownToString(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function deepGet(record: JsonRecord, path: string): unknown {
  if (!path.includes(".")) {
    return record[path];
  }

  const parts = path.split(".");
  let current: unknown = record;

  for (const part of parts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

function normalizeUnknownToString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const flattened = value
      .map((item) => normalizeUnknownToString(item))
      .filter((item): item is string => Boolean(item));
    return flattened.length > 0 ? flattened.join("\n") : null;
  }

  if (isRecord(value)) {
    for (const key of ["text", "content", "body", "markdown"]) {
      const nested = normalizeUnknownToString(value[key]);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function sanitizeFileName(input: string): string {
  return input.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+/g, "/");
}

function parentFolderOf(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function csvToKeys(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function matchesAnyRule(value: string, rules: string[]): boolean {
  if (!value) {
    return false;
  }

  return rules.some((rule) => value.includes(rule));
}

function isSproutReportNote(note: JsonRecord): boolean {
  const source = (pickFirstString(note, ["source"]) ?? "").toLowerCase();
  const noteType = (pickFirstString(note, ["note_type", "type"]) ?? "").toLowerCase();
  const title = pickFirstString(note, ["title"]) ?? "";
  const content = pickFirstString(note, ["content", "body", "text"]) ?? "";

  if (source !== "web" || noteType !== "plain_text") {
    return false;
  }

  const sproutMarkers = ["🌱 种子", "✨ Aha 瞬间", "## 01.", "## 02.", "## 03."];
  const matchedMarkers = sproutMarkers.filter((marker) => content.includes(marker)).length;

  return matchedMarkers >= 2 || title.includes("与");
}

function extractSection(text: string, headings: string[]): string | null {
  if (!text) {
    return null;
  }

  const escaped = headings.map(escapeRegex).join("|");
  const regex = new RegExp(`(?:^|\\n)(${escaped})\\n+([\\s\\S]*?)(?=\\n(?:### |## |# )|$)`, "m");
  const match = text.match(regex);
  if (!match?.[2]) {
    return null;
  }

  const section = match[2].trim();
  if (!section || section === "（空）" || section === "无") {
    return null;
  }

  return section;
}

function extractStructuredSections(text: string): {
  summary: string | null;
  chapters: string | null;
  quotes: string | null;
  todos: string | null;
  headings: string[];
  hasStructuredSections: boolean;
} {
  const sectionDefs = [
    { key: "summary", label: "智能总结", headings: ["### 📑 智能总结", "## 智能总结", "# 智能总结"] },
    { key: "chapters", label: "章节概要", headings: ["### 📅 章节概要", "## 章节概要", "# 章节概要"] },
    { key: "quotes", label: "金句精选", headings: ["### ✨ 金句精选", "## 金句精选", "# 金句精选"] },
    { key: "todos", label: "待办事项", headings: ["### 📋 待办事项", "## 待办事项", "# 待办事项"] },
  ] as const;

  const matches = sectionDefs
    .map((def) => {
      const match = findFirstHeading(text, def.headings);
      return match ? { ...def, index: match.index, heading: match.heading } : null;
    })
    .filter((item): item is (typeof sectionDefs)[number] & { index: number; heading: string } => Boolean(item))
    .sort((a, b) => a.index - b.index);

  const result = {
    summary: null as string | null,
    chapters: null as string | null,
    quotes: null as string | null,
    todos: null as string | null,
    headings: [] as string[],
    hasStructuredSections: matches.length > 0,
  };

  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const next = matches[i + 1];
    const start = current.index + current.heading.length;
    const end = next ? next.index : text.length;
    const value = text.slice(start, end).trim();
    const normalized = normalizeSectionValue(value);
    result[current.key] = normalized;
    result.headings.push(current.heading);
  }

  return result;
}

function stripKnownSections(text: string, headings: string[]): string | null {
  if (!text) {
    return null;
  }

  let result = text;
  for (const heading of headings) {
    const regex = new RegExp(`(?:^|\\n)${escapeRegex(heading)}\\n+[\\s\\S]*?(?=\\n(?:### |## |# )|$)`, "gm");
    result = result.replace(regex, "\n");
  }

  const cleaned = result.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || null;
}

function findFirstHeading(text: string, headings: readonly string[]): { index: number; heading: string } | null {
  let best: { index: number; heading: string } | null = null;

  for (const heading of headings) {
    const index = text.indexOf(heading);
    if (index === -1) {
      continue;
    }

    if (!best || index < best.index) {
      best = { index, heading };
    }
  }

  return best;
}

function normalizeSectionValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "（空）" || trimmed === "无") {
    return null;
  }
  return trimmed;
}

function pathToWikiTarget(path: string): string {
  return normalizePath(path).replace(/\.md$/i, "");
}

function renderTopicList(topicTags: string[]): string {
  return uniqueStrings(topicTags).map((tag) => `- ${tag}`).join("\n");
}

function readFrontmatterValue(content: string, key: string): string | null {
  const frontmatter = readFrontmatterBlock(content);
  if (!frontmatter) {
    return null;
  }

  const match = frontmatter.match(new RegExp(`^${escapeRegex(key)}:\\s*"?([^"\\n]+)"?$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function readFrontmatterList(content: string, key: string): string[] {
  const frontmatter = readFrontmatterBlock(content);
  if (!frontmatter) {
    return [];
  }

  const start = frontmatter.indexOf(`${key}:`);
  if (start === -1) {
    return [];
  }

  const lines = frontmatter.slice(start).split("\n").slice(1);
  const result: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("  - ")) {
      break;
    }
    result.push(line.replace(/^  - /, "").replace(/^"|"$/g, "").trim());
  }
  return result;
}

function readFrontmatterBlock(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match?.[1] ?? null;
}

function readSection(content: string, heading: string): string | null {
  const regex = new RegExp(`(?:^|\\n)## ${escapeRegex(heading)}\\n\\n([\\s\\S]*?)(?=\\n## [^\\n]+\\n|\\s*$)`);
  const match = content.match(regex);
  return match?.[1]?.trim() ?? null;
}

function updateNamedSection(content: string, heading: string, body: string): string {
  const trimmedBody = body.trim();
  const section = `## ${heading}\n\n${trimmedBody}`;
  const regex = new RegExp(`(?:^|\\n)## ${escapeRegex(heading)}\\n\\n[\\s\\S]*?(?=\\n## [^\\n]+\\n|\\s*$)`);

  if (regex.test(content)) {
    return content.replace(regex, `\n${section}\n`);
  }

  return `${content.trim()}\n\n${section}\n`;
}

function removeNamedSection(content: string, heading: string): string {
  const regex = new RegExp(`(?:^|\\n)## ${escapeRegex(heading)}\\n\\n[\\s\\S]*?(?=\\n## [^\\n]+\\n|\\s*$)`);
  if (!regex.test(content)) {
    return content;
  }

  return content.replace(regex, "\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function ensureSectionLink(content: string, heading: string, linkLine: string): string {
  const existing = readSection(content, heading);
  const lines = existing
    ? existing.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];

  if (!hasNormalizedLine(lines, linkLine)) {
    lines.push(linkLine);
  }

  return updateNamedSection(content, heading, dedupeSectionLines(lines).join("\n"));
}

function ensureTopicIndexScaffold(content: string, topic: string): string {
  const trimmed = content.trim();
  const frontmatter = [
    "---",
    'type: "topic-index"',
    `topic: "${escapeYamlString(topic)}"`,
    "tags:",
    "  - topic-index",
    "---",
  ].join("\n");

  const withFrontmatter = trimmed.startsWith("---") ? trimmed : `${frontmatter}\n\n${trimmed}`;
  const titleLine = `# ${topic}`;

  if (withFrontmatter.includes(titleLine)) {
    return withFrontmatter.endsWith("\n") ? withFrontmatter : `${withFrontmatter}\n`;
  }

  const frontmatterMatch = withFrontmatter.match(/^---\n[\s\S]*?\n---\n*/);
  if (!frontmatterMatch) {
    return `${frontmatter}\n\n${titleLine}\n\n${withFrontmatter}\n`;
  }

  const head = frontmatterMatch[0];
  const tail = withFrontmatter.slice(head.length).trimStart();
  return `${head}\n${titleLine}\n\n${tail}\n`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeComparableText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function dedupeSectionLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const normalized = normalizeSectionLine(line);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(line.trim());
  }

  return result;
}

function hasNormalizedLine(lines: string[], candidate: string): boolean {
  const normalizedCandidate = normalizeSectionLine(candidate);
  return lines.some((line) => normalizeSectionLine(line) === normalizedCandidate);
}

function normalizeSectionLine(line: string): string {
  const normalized = normalizeComparableText(line);
  const wikiMatch = normalized.match(/^- \[\[([^\]]+)\]\]$/);
  return wikiMatch ? `- [[${wikiMatch[1]}]]` : normalized;
}

function normalizeComparableText(value: string): string {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, "").normalize("NFKC").trim();
}

function normalizeTodoSection(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  if (lines.every((line) => line === "无")) {
    return "- 无";
  }

  return lines
    .map((line) => {
      if (/^[-*]\s/.test(line) || /^- \[ \]/.test(line) || /^- \[x\]/i.test(line)) {
        return line;
      }
      return `- [ ] ${line}`;
    })
    .join("\n");
}

function isLikelyAudioLike(value: string): boolean {
  return /(audio|voice|record|recorder|transcript|speech|bluetooth)/i.test(value);
}

function renderOriginalTranscriptSection(text: string, collapsed: boolean): string {
  const normalized = normalizeSectionValue(text);
  if (!normalized) {
    return "";
  }

  if (!collapsed) {
    return `## 原始转写\n\n${normalized}`;
  }

  const quoted = normalized
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

  return `## 原始转写\n\n> [!note]- 点击展开原始转写\n${quoted}`;
}

function renderMeetingOverview(createdAt: string | null, topicTags: string[]): string {
  const lines = [
    createdAt ? `> [!info] 会议卡片\n> - 时间：${createdAt}` : "> [!info] 会议卡片",
    `> - 主题数：${topicTags.length}`,
    topicTags.length > 0 ? `> - 标签：${topicTags.join(" / ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  return lines;
}

function preserveExistingOriginalTranscript(nextContent: string, currentContent: string): string {
  if (readSection(nextContent, "原始转写")) {
    return nextContent;
  }

  const existingOriginal = readSection(currentContent, "原始转写");
  if (!existingOriginal) {
    return nextContent;
  }

  return updateNamedSection(nextContent, "原始转写", existingOriginal);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function summarizeText(input: string | null, maxLength: number): string | null {
  if (!input) {
    return null;
  }

  const compact = input.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }

  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function escapeYamlString(value: string): string {
  return value.replace(/"/g, '\\"');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function compareNumericStrings(a: string, b: string): number {
  const left = a.replace(/^0+/, "") || "0";
  const right = b.replace(/^0+/, "") || "0";

  if (left.length !== right.length) {
    return left.length > right.length ? 1 : -1;
  }

  if (left === right) {
    return 0;
  }

  return left > right ? 1 : -1;
}

function maxNumericString(a: string, b: string): string {
  return compareNumericStrings(a, b) >= 0 ? a : b;
}

function minNumericString(values: string[]): string | null {
  if (values.length === 0) {
    return null;
  }

  let current = values[0];
  for (const value of values.slice(1)) {
    if (compareNumericStrings(value, current) < 0) {
      current = value;
    }
  }

  return current;
}

function decrementNumericString(value: string): string {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return "0";
  }

  if (normalized === "0") {
    return "0";
  }

  const digits = normalized.split("");
  let index = digits.length - 1;

  while (index >= 0) {
    if (digits[index] !== "0") {
      digits[index] = String(Number(digits[index]) - 1);
      break;
    }

    digits[index] = "9";
    index -= 1;
  }

  const decremented = digits.join("").replace(/^0+/, "");
  return decremented || "0";
}

function normalizeLicenseValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeLicenseExpiry(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "never") {
    return "never";
  }

  const parsed = moment(normalized, "YYYY-MM-DD", true);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "never";
}

function createDeviceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `gn-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

async function validateLicense(deviceId: string, rawLicense: string | null): Promise<LicenseState> {
  if (!rawLicense) {
    return {
      deviceId,
      rawLicense: null,
      isValid: false,
      statusText: "还没有填写授权码",
      expiresAt: null,
    };
  }

  const parts = rawLicense.split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) {
    return {
      deviceId,
      rawLicense,
      isValid: false,
      statusText: "授权码格式不正确",
      expiresAt: null,
    };
  }

  const signedPayload = parseSignedLicensePayload(parts[1]);
  if (signedPayload) {
    const signatureIsValid = await verifySignedLicense(parts[1], parts[2]);
    if (!signatureIsValid) {
      return {
        deviceId,
        rawLicense,
        isValid: false,
        statusText: "授权签名无效",
        expiresAt: normalizeLicenseExpiry(signedPayload.exp),
      };
    }

    const expiresAt = normalizeLicenseExpiry(signedPayload.exp);
    const allowedDeviceIds = getSignedLicenseDeviceIds(signedPayload);
    if (!signedPayload.unlimitedDevices && !allowedDeviceIds.includes(deviceId)) {
      return {
        deviceId,
        rawLicense,
        isValid: false,
        statusText: "授权码和当前设备不匹配",
        expiresAt: expiresAt === "never" ? null : expiresAt,
      };
    }

    if (expiresAt !== "never" && moment(expiresAt, "YYYY-MM-DD", true).endOf("day").isBefore(moment())) {
      return {
        deviceId,
        rawLicense,
        isValid: false,
        statusText: `授权已过期：${expiresAt}`,
        expiresAt,
      };
    }

    return {
      deviceId,
      rawLicense,
      isValid: true,
      statusText: expiresAt === "never" ? "授权有效" : `授权有效，至 ${expiresAt}`,
      expiresAt: expiresAt === "never" ? null : expiresAt,
    };
  }

  return validateLegacyLicense(deviceId, rawLicense, parts[1], parts[2]);
}

async function validateLegacyLicense(
  deviceId: string,
  rawLicense: string,
  expiryPart: string,
  checksumPart: string,
): Promise<LicenseState> {
  const expiresAt = normalizeLicenseExpiry(expiryPart);
  if (expiresAt !== "never" && moment(expiresAt, "YYYY-MM-DD", true).endOf("day").isBefore(moment())) {
    return {
      deviceId,
      rawLicense,
      isValid: false,
      statusText: `授权已过期：${expiresAt}`,
      expiresAt,
    };
  }

  const expectedChecksum = await createLegacyLicenseChecksum(deviceId, expiresAt);
  if (checksumPart !== expectedChecksum) {
    return {
      deviceId,
      rawLicense,
      isValid: false,
      statusText: "授权码格式不正确或签名无效",
      expiresAt: expiresAt === "never" ? null : expiresAt,
    };
  }

  return {
    deviceId,
    rawLicense,
    isValid: true,
    statusText: expiresAt === "never" ? "测试授权有效" : `测试授权有效，至 ${expiresAt}`,
    expiresAt: expiresAt === "never" ? null : expiresAt,
  };
}

async function createLegacyLicenseChecksum(deviceId: string, expiresAt: string): Promise<string> {
  const payload = `${deviceId}:${expiresAt}:${LEGACY_LICENSE_SALT}`;
  const hash = await sha256Hex(payload);
  return hash.slice(0, LEGACY_LICENSE_CHECKSUM_LENGTH);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function parseSignedLicensePayload(payloadBase64Url: string): SignedLicensePayload | null {
  try {
    const payloadText = decodeBase64UrlToString(payloadBase64Url);
    const payload = JSON.parse(payloadText) as SignedLicensePayload;
    if (!payload || typeof payload.exp !== "string") {
      return null;
    }

    const deviceIds = getSignedLicenseDeviceIds(payload);
    if (!payload.unlimitedDevices && deviceIds.length === 0) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function getSignedLicenseDeviceIds(payload: SignedLicensePayload): string[] {
  const deviceIds = Array.isArray(payload.deviceIds)
    ? payload.deviceIds.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const legacyDeviceId = typeof payload.deviceId === "string" ? payload.deviceId.trim() : "";
  return uniqueStrings([...deviceIds, legacyDeviceId].filter(Boolean));
}

async function verifySignedLicense(payloadBase64Url: string, signatureBase64Url: string): Promise<boolean> {
  try {
    const publicKey = await importLicensePublicKey();
    const signature = base64UrlToArrayBuffer(signatureBase64Url);
    const signedBytes = new TextEncoder().encode(`${LICENSE_PREFIX}.${payloadBase64Url}`);
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signature,
      signedBytes,
    );
  } catch {
    return false;
  }
}

let licensePublicKeyPromise: Promise<CryptoKey> | null = null;

async function importLicensePublicKey(): Promise<CryptoKey> {
  if (!licensePublicKeyPromise) {
    const binaryDer = pemToArrayBuffer(LICENSE_PUBLIC_KEY_PEM);
    licensePublicKeyPromise = crypto.subtle.importKey(
      "spki",
      binaryDer,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["verify"],
    );
  }

  return licensePublicKeyPromise;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function decodeBase64UrlToString(value: string): string {
  const bytes = base64UrlToUint8Array(value);
  return new TextDecoder().decode(bytes);
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const bytes = base64UrlToUint8Array(value);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function base64UrlToUint8Array(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function copyToClipboard(value: string): Promise<boolean> {
  if (!value) {
    return false;
  }

  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
