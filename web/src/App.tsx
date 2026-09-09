import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './App.module.css';
import {
  archiveSession as apiArchiveSession,
  renameSession as apiRenameSession,
  renameWorkspace as apiRenameWorkspace,
  selectWorkspace as apiSelectWorkspace,
  createRun,
  deleteWorkspaceGroup,
  downloadSessionExport,
  fetchSessionStats,
  getDefaultModel,
  getDirectoryPickerCapability,
  getSessionGoal,
  getSessionPlanMode,
  getWorkspace,
  listFiles,
  listModels,
  listPiAiProviders,
  listRuns,
  listSessions,
  openWorkspace,
  requestSessionCompact,
  resumeRun,
  sendSessionFeedback,
  setDefaultModel,
  setSessionGoal,
  setSessionPlanMode,
  stopRun,
} from './api';
import { matchModelByQuery, matchPermissionMode } from './commands/builtin-commands';
import { FileModal } from './components/FileModal';
import { InputBar } from './components/InputBar';
import { SettingsModal } from './components/SettingsModal';
import { ShellBar } from './components/ShellBar';
import { Sidebar } from './components/Sidebar';
import { Timeline } from './components/Timeline';
import {
  applyCompactUsage,
  type CompactStatusState,
  compactStatusText,
} from './components/Timeline/context-gauge';
import { TurnNavigator } from './components/TurnNavigator';
import { WorkspacePickerModal } from './components/WorkspacePickerModal';
import { useConversationScroll } from './hooks/useConversationScroll';
import { useGeneralSettings } from './hooks/useGeneralSettings';
import { useThemeMode } from './hooks/useThemeMode';
import type {
  ContextUsageEvent,
  DefaultModelView,
  DirectoryListing,
  DirectoryPickerCapability,
  FileEntry,
  HostRun,
  HostSession,
  ModelProviderView,
  ModelSelection,
  PiAiProviderInfo,
  SessionStats,
  WorkspaceView,
} from './types';
import { alignedAttachmentName, prepareImageForUpload } from './utils/image-prepare';

// 与会话标题生成规则（与 src/host/run-manager.ts sessionTitle 保持一致）
function sessionTitle(task: string): string {
  return task.replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名任务';
}

interface QueuedMessage {
  id: string;
  task: string;
  attachments?: File[];
}

export default function App() {
  const [themeMode, setThemeMode] = useThemeMode();
  const { permissionMode, setPermissionMode, language, setLanguage, fontSize, setFontSize } =
    useGeneralSettings();
  const [runs, setRuns] = useState<HostRun[]>([]);
  const [sessions, setSessions] = useState<HostSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  // 会话级统计投影（顶栏 stats strip；会话切换/回合终态时刷新）
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  // /plan 计划模式（会话级元数据；进入后下一轮强制只读 + 仅产出方案）
  const [planMode, setPlanModeState] = useState(false);
  // /compact 状态行（DSH 式：进行中 → 量化结果），随会话切换/新消息清除
  const [compactStatus, setCompactStatus] = useState<CompactStatusState | null>(null);
  // 上下文预算环形指示器数据：Timeline 从 context_usage 事件上抛，输入栏展示
  const [contextUsage, setContextUsage] = useState<ContextUsageEvent | null>(null);
  const [online, setOnline] = useState(false);
  const [, setFiles] = useState<FileEntry[]>([]);
  const [viewingFile, setViewingFile] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarUserOverrideRef = useRef(false);
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerCapability, setPickerCapability] = useState<DirectoryPickerCapability | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerCreating, setPickerCreating] = useState(false);
  const [pickerListing, setPickerListing] = useState<DirectoryListing | null>(null);
  const [resumingRun, setResumingRun] = useState(false);
  const [preferredWorkspaceName, setPreferredWorkspaceName] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defaultModel, setDefaultModelState] = useState<DefaultModelView | null>(null);
  const [models, setModels] = useState<ModelProviderView[]>([]);
  // pi-ai 内置目录：用于解析未显式配置视觉开关的内置 Provider 模型是否支持图片输入
  const [piProviders, setPiProviders] = useState<PiAiProviderInfo[]>([]);
  const previousDefaultModelRef = useRef<DefaultModelView | null>(null);
  const modelSaveVersionRef = useRef(0);
  // 默认模型保存请求在途标记：轮询/聚焦刷新时避免用旧服务端快照覆盖乐观更新
  const defaultModelSaveInFlightRef = useRef(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  const handleSelectModel = useCallback(
    (providerId: string, model: string) => {
      const previous = previousDefaultModelRef.current ?? {
        defaultProviderId: '',
        defaultModelId: '',
      };
      const next = { defaultProviderId: providerId, defaultModelId: model };
      setDefaultModelState(next);
      previousDefaultModelRef.current = next;

      const version = ++modelSaveVersionRef.current;
      defaultModelSaveInFlightRef.current = true;
      setDefaultModel(providerId, model)
        .then(() => {
          if (version === modelSaveVersionRef.current) {
            // 最新请求成功：确认 UI
          }
        })
        .catch((err: unknown) => {
          if (version === modelSaveVersionRef.current) {
            const msg = err instanceof Error ? err.message : String(err);
            showToast(`默认模型保存失败：${msg}`);
            setDefaultModelState(previous);
            previousDefaultModelRef.current = previous;
          }
        })
        .finally(() => {
          if (version === modelSaveVersionRef.current) {
            defaultModelSaveInFlightRef.current = false;
          }
        });
    },
    [showToast],
  );

  const refreshRuns = useCallback(async () => {
    try {
      const runResp = await listRuns();
      setRuns(runResp.runs);
      setOnline(true);
    } catch {
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSessionStats = useCallback(async (sessionId: string | null) => {
    if (!sessionId) {
      setSessionStats(null);
      return;
    }
    try {
      const stats = await fetchSessionStats(sessionId);
      setSessionStats(stats);
    } catch {
      // 统计是展示增强，失败静默降级（顶栏不显示条）
    }
  }, []);

  // 会话切换 / 打开时拉取统计与计划模式状态
  useEffect(() => {
    void refreshSessionStats(currentSessionId);
    if (!currentSessionId) {
      setPlanModeState(false);
      setCompactStatus(null);
      return;
    }
    getSessionPlanMode(currentSessionId)
      .then((resp) => setPlanModeState(resp.planMode))
      .catch(() => {});
  }, [currentSessionId, refreshSessionStats]);

  const refreshDefaultModel = useCallback(async () => {
    // 本地保存请求在途时跳过：避免用旧服务端快照覆盖乐观更新
    if (defaultModelSaveInFlightRef.current) return;
    try {
      const resp = await getDefaultModel();
      const next = {
        defaultProviderId: resp.defaultProviderId,
        defaultModelId: resp.defaultModelId,
      };
      setDefaultModelState(next);
      previousDefaultModelRef.current = next;
    } catch {
      // ignore：下拉仍可用，仅默认选择显示为占位
    }
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      const resp = await listModels();
      setModels(resp.models);
    } catch {
      // ignore
    }
  }, []);

  // pi-ai 目录只影响视觉能力提示，加载失败静默降级（不显示视觉警告）
  const refreshPiProviders = useCallback(async () => {
    try {
      const resp = await listPiAiProviders();
      setPiProviders(resp.providers);
    } catch {
      // ignore
    }
  }, []);

  const refreshSessions = useCallback(
    async (mode: 'merge' | 'replace' = 'merge'): Promise<HostSession[]> => {
      try {
        const sessionResp = await listSessions();
        // merge：与乐观插入的 sessions 合并，服务端同 sessionId 项优先（title/workspace 以服务端为准）；
        // replace：以服务端为准整体替换（删除工作区后必须换，否则被删会话残留前端）。
        if (mode === 'replace') {
          setSessions(sessionResp.sessions);
        } else {
          setSessions((prev) => {
            const byId = new Map(prev.map((s) => [s.sessionId, s]));
            for (const s of sessionResp.sessions) byId.set(s.sessionId, s);
            return Array.from(byId.values());
          });
        }
        return sessionResp.sessions;
      } catch (err) {
        console.error('Failed to refresh sessions:', err);
        throw err;
      }
    },
    [],
  );

  useEffect(() => {
    void refreshRuns();
    void refreshSessions();
    getWorkspace()
      .then((resp) => setWorkspace(resp.workspace))
      .catch(() => {});
    getDirectoryPickerCapability()
      .then((resp) => setPickerCapability(resp.capability))
      .catch(() => setPickerCapability({ kind: 'browse' as const }));
    void refreshModels();
    void refreshPiProviders();
    void refreshDefaultModel();
  }, [refreshRuns, refreshSessions, refreshModels, refreshPiProviders, refreshDefaultModel]);

  // 窄视口下自动折叠 Sidebar；用户手动切换后不再自动干预本次会话
  useEffect(() => {
    const breakpoint = 900;
    const onResize = () => {
      if (sidebarUserOverrideRef.current) return;
      setSidebarCollapsed(window.innerWidth < breakpoint);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 监听 Settings 默认模型变更（含在 Settings 内点"设为默认"）
  useEffect(() => {
    const handler = () => {
      void refreshModels();
      void refreshDefaultModel();
    };
    window.addEventListener('settings:defaultChanged', handler);
    return () => window.removeEventListener('settings:defaultChanged', handler);
  }, [refreshDefaultModel, refreshModels]);

  const currentRun = runs.find((r) => r.runId === currentRunId) ?? null;
  const currentSession = sessions.find((s) => s.sessionId === currentSessionId) ?? null;

  // 下拉的当前选择 = 默认模型对 + provider 目录派生；目录未加载或对不上时显示占位
  const currentModelSelection: ModelSelection | null = (() => {
    if (!defaultModel?.defaultProviderId) return null;
    const provider = models.find((m) => m.id === defaultModel.defaultProviderId);
    if (!provider) return null;
    const model =
      defaultModel.defaultModelId && provider.models.includes(defaultModel.defaultModelId)
        ? defaultModel.defaultModelId
        : provider.models[0];
    if (!model) return null;
    const capability = provider.modelCapabilities?.[model];
    return {
      providerId: provider.id,
      providerName: provider.name,
      model,
      ...(capability?.contextWindow !== undefined
        ? { contextWindow: capability.contextWindow }
        : {}),
      ...(capability?.maxOutputTokens !== undefined
        ? { maxOutputTokens: capability.maxOutputTokens }
        : {}),
    };
  })();

  // 当前模型是否支持图片输入：设置显式 true/false 均优先，否则 pi-ai 注册表推断。
  // 三态与后端 run-manager.resolveVision 保持一致——显式 false 可关掉注册表声明。
  const currentModelVision: boolean = (() => {
    if (!currentModelSelection) return false;
    const provider = models.find((m) => m.id === currentModelSelection.providerId);
    if (!provider) return false;
    const explicit = provider.modelCapabilities?.[currentModelSelection.model]?.vision;
    if (explicit === true) return true;
    if (explicit === false) return false;
    if (provider.piProviderId) {
      const pi = piProviders.find((p) => p.id === provider.piProviderId);
      return (
        pi?.models.some((m) => m.id === currentModelSelection.model && m.input.includes('image')) ??
        false
      );
    }
    return false;
  })();

  const currentSessionRuns = runs
    .filter((run) => run.sessionId === currentSessionId)
    .sort((a, b) => a.turnIndex - b.turnIndex);
  // Composer 属于整个会话，其上下文预算应始终取会话最新一轮。
  // currentRunId 只表示当前滚动/导航到的历史回合，不能改变 Composer 预算。
  const latestSessionRunId = currentSessionRuns[currentSessionRuns.length - 1]?.runId ?? null;
  const latestSessionRun = currentSessionRuns[currentSessionRuns.length - 1] ?? null;
  const sessionBusy =
    latestSessionRun?.status === 'running' || latestSessionRun?.status === 'stopping';
  const [sendQueue, setSendQueue] = useState<QueuedMessage[]>([]);
  const queueDispatchingRef = useRef(false);
  const immediateStopRunIdRef = useRef<string | null>(null);
  const [sentRunId, setSentRunId] = useState<string | null>(null);
  const { scrollRef: conversationScrollRef, contentRef: conversationContentRef } =
    useConversationScroll(currentSessionId, sentRunId);

  // Poll run files (kept for future "附件" row; not displayed inline).
  useEffect(() => {
    if (!currentRunId) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    listFiles(currentRunId)
      .then((resp) => {
        if (!cancelled) setFiles(resp.files);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentRunId]);

  const createRunNow = useCallback(
    // 返回 true = Run 已创建；false = 创建失败（内部已 alert）。InputBar 据此还原草稿。
    async (task: string, attachments?: File[]): Promise<boolean> => {
      const trimmed = task.trim();
      if (!trimmed) return true;
      setCompactStatus(null);
      try {
        // 客户端先压像素再转 base64（附件 v2 P2：请求体从 20MB 级降回 ~2MB 级）；
        // 落盘后 Host 只在工作区保留归一化文件，base64 不进入任何持久化状态。
        // mimeType 取实际编码产物（浏览器可能回退编码格式，Host 会嗅探校验）。
        const attachmentPayload = attachments?.length
          ? await Promise.all(
              attachments.map(async (file) => {
                const prepared = await prepareImageForUpload(file);
                return {
                  // 扩展名对齐实际编码产物（浏览器回退编码时 mime 可能变化）
                  name: alignedAttachmentName(
                    file.name.replace(/[\\/]/g, '_') || 'image.png',
                    prepared.mimeType,
                  ),
                  mimeType: prepared.mimeType || 'application/octet-stream',
                  dataBase64: prepared.dataBase64,
                };
              }),
            )
          : undefined;
        const resp = await createRun(
          trimmed,
          currentSessionId ?? undefined,
          preferredWorkspaceName ?? undefined,
          permissionMode,
          currentModelSelection
            ? { providerId: currentModelSelection.providerId, model: currentModelSelection.model }
            : undefined,
          attachmentPayload,
        );
        const isNewSession = !currentSessionId;
        // 立刻把刚创建的 Run 合并进 runs 数组（乐观更新），避免等 refreshRuns 回来之前 landing 分支还在显示
        const optimisticRun: HostRun = {
          runId: resp.runId,
          sessionId: resp.sessionId,
          turnIndex: currentSessionRuns.length,
          task: trimmed,
          status: (resp.status as HostRun['status']) ?? 'running',
          workspace: workspace ?? undefined,
          providerId: currentModelSelection?.providerId,
          model: currentModelSelection?.model,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          permissionMode: resp.permissionMode,
        };
        setCurrentSessionId(resp.sessionId);
        setCurrentRunId(resp.runId);
        setSentRunId(resp.runId);
        setRuns((prev) => {
          if (prev.some((r) => r.runId === optimisticRun.runId)) return prev;
          return [...prev, optimisticRun];
        });
        // 新建会话时，左侧栏立刻显示（不等下一次轮询）
        if (isNewSession) {
          const optimisticSession: HostSession = {
            sessionId: resp.sessionId,
            title: sessionTitle(trimmed),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            workspace: workspace ?? undefined,
          };
          setSessions((prev) => {
            if (prev.some((s) => s.sessionId === optimisticSession.sessionId)) return prev;
            return [optimisticSession, ...prev];
          });
        }
        // Session 列表与 Run 状态解耦；仅新建会话后做一次服务端同步。
        if (isNewSession) void refreshSessions();
        setPreferredWorkspaceName(null);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Failed to create run:', err);
        alert(`任务创建失败：${msg}`);
        return false;
      }
    },
    [
      currentSessionId,
      currentSessionRuns.length,
      permissionMode,
      preferredWorkspaceName,
      refreshSessions,
      workspace,
      currentModelSelection,
    ],
  );

  const handleCreateRun = useCallback(
    // 返回 Promise<boolean>：入队视为成功（true）；直接创建透传 createRunNow 的成败
    (task: string, attachments?: File[]): Promise<boolean> => {
      if (sessionBusy || queueDispatchingRef.current || sendQueue.length > 0) {
        setSendQueue((queue) => [...queue, { id: crypto.randomUUID(), task, attachments }]);
        return Promise.resolve(true);
      }
      return createRunNow(task, attachments);
    },
    [createRunNow, sendQueue.length, sessionBusy],
  );

  const handleSendQueuedNow = useCallback(
    (messageId: string) => {
      setSendQueue((queue) => {
        const index = queue.findIndex((message) => message.id === messageId);
        if (index < 0) return queue;
        const message = queue[index];
        if (!message) return queue;
        if (index === 0) return queue;
        return [message, ...queue.slice(0, index), ...queue.slice(index + 1)];
      });

      // “立即发送”不能与当前会话并发，否则两轮消息会同时竞争同一份上下文。
      // 先请求当前 Run 停止，Run 真正进入终态后由队列 effect 立即派发队首消息。
      const activeRun = latestSessionRun;
      if (!activeRun) return;
      if (activeRun.status !== 'running' || immediateStopRunIdRef.current === activeRun.runId) {
        return;
      }
      immediateStopRunIdRef.current = activeRun.runId;
      showToast('正在停止当前任务，准备发送队列消息…');
      void stopRun(activeRun.runId)
        .then(() => refreshRuns())
        .catch((err: unknown) => {
          immediateStopRunIdRef.current = null;
          const msg = err instanceof Error ? err.message : String(err);
          showToast(`立即发送失败：${msg}`);
        });
    },
    [latestSessionRun, refreshRuns, showToast],
  );

  const handleDeleteQueued = useCallback((messageId: string) => {
    setSendQueue((queue) => queue.filter((message) => message.id !== messageId));
  }, []);

  useEffect(() => {
    if (
      !currentSessionId ||
      !latestSessionRun ||
      sessionBusy ||
      sendQueue.length === 0 ||
      queueDispatchingRef.current
    ) {
      return;
    }

    const [next] = sendQueue;
    if (!next) return;
    queueDispatchingRef.current = true;
    setSendQueue((queue) => queue.slice(1));
    void createRunNow(next.task, next.attachments).finally(() => {
      queueDispatchingRef.current = false;
      // A message may have been queued while createRunNow was in flight.
      // Create a new array so the effect runs again after the ref is cleared.
      setSendQueue((queue) => [...queue]);
    });
  }, [createRunNow, currentSessionId, latestSessionRun, sendQueue, sessionBusy]);

  const handleRunTerminal = useCallback(() => {
    // SSE 已携带终态；这里只做一次持久化状态对账，不启动后台轮询。
    void refreshRuns();
    void refreshSessionStats(currentSessionId);
  }, [refreshRuns, refreshSessionStats, currentSessionId]);

  // 内置斜杠命令执行器（命令模式：name → handler 映射，InputBar 发送时拦截调用）
  const handleBuiltinCommand = useCallback(
    async (name: string, args: string) => {
      const requireSession = (): string => {
        if (!currentSessionId) throw new Error('请先打开一个会话再使用该命令');
        return currentSessionId;
      };
      try {
        if (name === 'compact') {
          const sessionId = requireSession();
          setCompactStatus({ phase: 'running' });
          try {
            const resp = await requestSessionCompact(sessionId);
            setCompactStatus({
              phase: 'done',
              summarizedMessages: resp.summarizedMessages,
              compactedTokens: resp.compactedTokens,
              reason: resp.reason,
            });
            // 压缩后视图占用合成进最近一条 context_usage：占用环立即下降，
            // 下一轮真实的 context_usage 事件会再次覆盖。
            if (resp.usage) {
              const synthesized = applyCompactUsage(contextUsage, resp.usage);
              if (synthesized) setContextUsage(synthesized);
            }
          } catch (err) {
            setCompactStatus(null);
            throw err;
          }
          return;
        }
        if (name === 'export') {
          const sessionId = requireSession();
          downloadSessionExport(sessionId);
          showToast('会话日志归档已开始下载');
          return;
        }
        if (name === 'feedback') {
          if (!args) {
            showToast('用法：/feedback <意见>');
            return;
          }
          const sessionId = requireSession();
          await sendSessionFeedback(sessionId, args);
          showToast('反馈已记录，谢谢！');
          return;
        }
        if (name === 'goal') {
          if (!args) {
            const sessionId = requireSession();
            const resp = await getSessionGoal(sessionId);
            showToast(resp.goal ? `当前目标：${resp.goal}` : '未设置目标；用法 /goal <目标内容>');
            return;
          }
          await setSessionGoal(requireSession(), args);
          showToast('会话目标已更新');
          return;
        }
        if (name === 'permission') {
          if (!args) {
            showToast(
              `当前权限：${permissionMode}；用法 /permission read-only | workspace-write | full-access`,
            );
            return;
          }
          const mode = matchPermissionMode(args);
          if (!mode) {
            showToast('无法识别的权限档；可用 read-only / workspace-write / full-access');
            return;
          }
          setPermissionMode(mode);
          showToast(`权限已切换：${mode}（对下一轮生效）`);
          return;
        }
        if (name === 'plan') {
          const sessionId = requireSession();
          const next = !planMode;
          await setSessionPlanMode(sessionId, next);
          setPlanModeState(next);
          showToast(
            next
              ? '已进入计划模式：只读 + 仅产出方案（对下一轮生效）；再次 /plan 退出'
              : '已退出计划模式',
          );
          return;
        }
        if (name === 'model') {
          if (!args) {
            showToast(
              defaultModel
                ? `当前模型：${defaultModel.defaultProviderId}/${defaultModel.defaultModelId}；用法 /model <关键词>`
                : '用法：/model <provider/模型关键词>',
            );
            return;
          }
          const { match, candidates } = matchModelByQuery(models, args);
          if (match) {
            handleSelectModel(match.providerId, match.model);
            showToast(`模型已切换：${match.providerId}/${match.model}`);
            return;
          }
          if (candidates.length > 1) {
            const listed = candidates
              .slice(0, 5)
              .map((candidate) => `${candidate.providerId}/${candidate.model}`)
              .join('、');
            showToast(`匹配到 ${candidates.length} 个模型，请更精确：${listed}`);
            return;
          }
          showToast('没有匹配的模型；用 /model <provider/模型关键词> 重试');
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(`/${name} 执行失败：${message}`);
      }
    },
    [
      contextUsage,
      currentSessionId,
      defaultModel,
      handleSelectModel,
      models,
      permissionMode,
      planMode,
      setPermissionMode,
      showToast,
    ],
  );

  const handleStopRun = useCallback(async () => {
    if (!currentRunId) return;
    try {
      await stopRun(currentRunId);
      refreshRuns();
    } catch (err) {
      console.error('Failed to stop run:', err);
    }
  }, [currentRunId, refreshRuns]);

  const handleResumeRun = useCallback(async () => {
    if (!currentRunId || resumingRun) return;
    setResumingRun(true);
    try {
      await resumeRun(currentRunId);
      await refreshRuns();
    } catch (err) {
      console.error('Failed to resume run:', err);
    } finally {
      setResumingRun(false);
    }
  }, [currentRunId, refreshRuns, resumingRun]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setSendQueue([]);
      const sessionRuns = runs
        .filter((run) => run.sessionId === sessionId)
        .sort((a, b) => b.turnIndex - a.turnIndex);
      setCurrentSessionId(sessionId);
      setCurrentRunId(sessionRuns[0]?.runId ?? null);
      setContextUsage(null); // 切换会话时清空，待新 Timeline 回放后更新
      setViewingFile(null);
    },
    [runs],
  );

  // TurnNavigator：点击/键盘选择某个历史回合 → 切换查看该 run 并滚动到对应 Timeline
  const handleNavigateRun = useCallback((runId: string) => {
    setCurrentRunId(runId);
    // 等当前 Run 渲染后滚动（setState 异步，延迟一帧）
    requestAnimationFrame(() => {
      document
        .getElementById(`run-${runId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const handleNewTask = useCallback(() => {
    setSendQueue([]);
    setCurrentRunId(null);
    setCurrentSessionId(null);
    setViewingFile(null);
    // 顶层「新建任务」沿用徽标所示工作区（若有），保证创建结果与显示一致
    setPreferredWorkspaceName(workspace?.name ?? null);
    setTimeout(() => {
      const input = document.querySelector('textarea');
      input?.focus();
    }, 50);
  }, [workspace]);

  const handleNewTaskInWorkspace = useCallback((workspaceName: string) => {
    // 切到 landing 并记住目标工作区；用户提交任务时 createRun 会带上 workspaceName，
    // 后端新建会话并继承该工作区根目录（会话创建后清空偏好）。
    setPreferredWorkspaceName(workspaceName);
    setSendQueue([]);
    // 同步 workspace 显示态：徽标立即显示「pi」而非「选择 Workspace」，
    // 乐观插入的 Run/Session 也带上工作区（否则侧栏先落「未选择工作区」组）
    setWorkspace({ name: workspaceName });
    setCurrentRunId(null);
    setCurrentSessionId(null);
    setViewingFile(null);
    setTimeout(() => {
      const input = document.querySelector('textarea');
      input?.focus();
    }, 50);
  }, []);

  const handleRenameWorkspace = useCallback(
    async (fromName: string, toName: string) => {
      try {
        await apiRenameWorkspace(fromName, toName);
        setWorkspace((w) => (w && w.name === fromName ? { name: toName } : w));
        await refreshSessions('replace');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        alert(`重命名失败：${msg}`);
      }
    },
    [refreshSessions],
  );

  const handleDeleteWorkspace = useCallback(
    async (name: string) => {
      try {
        await deleteWorkspaceGroup(name);
        setWorkspace((w) => (w && w.name === name ? null : w));
        const remaining = await refreshSessions('replace');
        setSessions(remaining);
        // 当前会话所属工作区被删除 → 回到 landing
        if (currentSessionId && !remaining.some((s) => s.sessionId === currentSessionId)) {
          setSendQueue([]);
          setCurrentSessionId(null);
          setCurrentRunId(null);
          setViewingFile(null);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        alert(`删除工作区失败：${msg}`);
      }
    },
    [currentSessionId, refreshSessions],
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, title: string) => {
      try {
        await apiRenameSession(sessionId, title);
        setSessions((prev) =>
          prev.map((s) =>
            s.sessionId === sessionId ? { ...s, title, updatedAt: new Date().toISOString() } : s,
          ),
        );
        showToast('重命名成功');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast(`重命名失败：${msg}`);
      }
    },
    [showToast],
  );

  const handleArchiveSession = useCallback(
    async (sessionId: string) => {
      try {
        await apiArchiveSession(sessionId);
        // 乐观更新：立即从列表移除，避免用户看到“什么都没发生”
        setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
        if (currentSessionId === sessionId) {
          setSendQueue([]);
          setCurrentSessionId(null);
          setCurrentRunId(null);
          setViewingFile(null);
        }
        showToast('已归档');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast(`归档失败：${msg}`);
      }
      // 后台与服务端对齐；失败只记日志，不打扰用户
      void refreshSessions('replace').catch((err) => {
        console.error('Failed to refresh sessions:', err);
      });
    },
    [currentSessionId, refreshSessions, showToast],
  );

  const handleOpenWorkspace = useCallback(async () => {
    if (openingWorkspace) return;
    setOpeningWorkspace(true);
    setPickerError(null);
    try {
      if (pickerCapability?.kind === 'browse') {
        setPickerOpen(true);
      } else {
        const resp = await openWorkspace();
        if (!resp.cancelled) setWorkspace(resp.workspace);
      }
    } catch (err) {
      console.error('Failed to open workspace:', err);
      setPickerError(err instanceof Error ? err.message : '打开工作区失败');
    } finally {
      setOpeningWorkspace(false);
    }
  }, [openingWorkspace, pickerCapability]);

  // 网页内目录选择器确认后采纳：与 native picker 等价地切换 Host 当前
  // Workspace（Host 侧走 canonicalizeWorkspaceRoot 校验，不弹系统窗口）。
  const handlePickerSelect = useCallback(
    async (path: string) => {
      try {
        const resp = await apiSelectWorkspace(path);
        setWorkspace(resp.workspace);
        setPickerOpen(false);
      } catch (err) {
        console.error('Failed to select workspace:', err);
        setPickerError(err instanceof Error ? err.message : '选择工作区失败');
        showToast(err instanceof Error ? err.message : '选择工作区失败');
      }
    },
    [showToast],
  );

  void online;
  void loading;

  return (
    <div className={`${styles.app} ${currentRun ? '' : styles.landing}`}>
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onNewTask={handleNewTask}
        onNewTaskInWorkspace={handleNewTaskInWorkspace}
        onRenameWorkspace={handleRenameWorkspace}
        onDeleteWorkspace={handleDeleteWorkspace}
        onRenameSession={handleRenameSession}
        onArchiveSession={handleArchiveSession}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => {
          sidebarUserOverrideRef.current = true;
          setSidebarCollapsed((value) => !value);
        }}
        workspace={workspace}
        openingWorkspace={openingWorkspace}
        onOpenWorkspace={handleOpenWorkspace}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className={`${styles.main} ${currentSessionId ? styles.sessionMain : ''}`}>
        <div
          className={`${styles.deerBackdrop} ${currentSessionId ? styles.sessionDeerBackdrop : ''}`}
          aria-hidden="true"
        />
        <ShellBar
          run={currentRun}
          title={currentSession?.title}
          onResume={handleResumeRun}
          resuming={resumingRun}
          stats={sessionStats}
          planMode={planMode}
        />

        {currentSessionId ? (
          <div className={styles.workspace}>
            <div className={styles.sessionTimeline} ref={conversationScrollRef}>
              {/* 0 高 sticky 槽必须挂在滚动容器内部，rail 才能钉在可视带右缘 */}
              <TurnNavigator
                runs={currentSessionRuns}
                activeRunId={currentRunId}
                onNavigate={handleNavigateRun}
              />
              <div ref={conversationContentRef}>
                {currentSessionRuns.length > 0 ? (
                  currentSessionRuns.map((run) => (
                    <Timeline
                      key={run.runId}
                      run={run}
                      modelFallback={null}
                      embedded
                      onRunTerminal={handleRunTerminal}
                      onRetryCommand={handleCreateRun}
                      onContextUsage={
                        run.runId === latestSessionRunId ? setContextUsage : undefined
                      }
                    />
                  ))
                ) : (
                  <div className={styles.sessionTimelineEmpty}>
                    <p>正在准备工作区…</p>
                  </div>
                )}
                {compactStatus && (
                  <div className={styles.compactStatus} role="status">
                    <span className={styles.compactCmd}>compact</span>
                    <span className={styles.compactSep}>·</span>
                    {compactStatusText(compactStatus)}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.emptyState}>
            <div className={styles.heroTitleRow}>
              <span className={styles.emptyLogo} role="img" aria-label="Payaso" />
              <h1 className={styles.emptyTitle}>路漫漫其修远兮，吾将上下而求索。</h1>
            </div>
            <InputBar
              variant="hero"
              onSend={handleCreateRun}
              placeholder="描述你想要构建的内容"
              workspaceName={workspace?.name}
              openingWorkspace={openingWorkspace}
              onOpenWorkspace={handleOpenWorkspace}
              currentModel={currentModelSelection ?? undefined}
              models={models}
              onSelectModel={handleSelectModel}
              visionSupported={currentModelVision}
              permissionMode={permissionMode}
              onSelectPermission={setPermissionMode}
              onBuiltinCommand={handleBuiltinCommand}
            />
          </div>
        )}

        {currentSessionId && currentRun && (
          <InputBar
            onSend={handleCreateRun}
            onStop={handleStopRun}
            isRunning={currentRun.status === 'running' || currentRun.status === 'stopping'}
            isStopping={currentRun.status === 'stopping'}
            currentModel={currentModelSelection ?? undefined}
            models={models}
            onSelectModel={handleSelectModel}
            visionSupported={currentModelVision}
            contextUsage={contextUsage ?? undefined}
            queuedCount={sendQueue.length}
            queuedMessages={sendQueue}
            onSendQueuedNow={handleSendQueuedNow}
            onDeleteQueued={handleDeleteQueued}
            permissionMode={permissionMode}
            onSelectPermission={setPermissionMode}
            onBuiltinCommand={handleBuiltinCommand}
          />
        )}
      </div>

      {viewingFile && currentRunId && (
        <FileModal runId={currentRunId} file={viewingFile} onClose={() => setViewingFile(null)} />
      )}

      {pickerOpen && (
        <WorkspacePickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={(path) => {
            void handlePickerSelect(path);
          }}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          themeMode={themeMode}
          onThemeModeChange={setThemeMode}
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          language={language}
          onLanguageChange={setLanguage}
          fontSize={fontSize}
          onFontSizeChange={setFontSize}
          onSaved={() => {
            void refreshModels();
            void refreshDefaultModel();
          }}
        />
      )}

      {toast && <div className={styles.toast}>{toast}</div>}
    </div>
  );
}
