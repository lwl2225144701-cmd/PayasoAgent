import { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ShellBar } from './components/ShellBar';
import { Timeline } from './components/Timeline';
import { InputBar } from './components/InputBar';
import { FileModal } from './components/FileModal';
import { SettingsModal } from './components/SettingsModal';
import { TurnNavigator } from './components/TurnNavigator';
import { useThemeMode } from './hooks/useThemeMode';
import { useGeneralSettings } from './hooks/useGeneralSettings';
import {
  createRun,
  deleteWorkspaceGroup,
  getDefaultModel,
  getWorkspace,
  listRuns,
  listSessions,
  listFiles,
  listModels,
  openWorkspace,
  renameWorkspace as apiRenameWorkspace,
  renameSession as apiRenameSession,
  archiveSession as apiArchiveSession,
  resumeRun,
  setDefaultModel,
  stopRun,
} from './api';
import type { DefaultModelView, FileEntry, HostRun, HostSession, ModelProviderView, ModelSelection, WorkspaceView } from './types';
import styles from './App.module.css';

// 与会话标题生成规则（与 src/host/run-manager.ts sessionTitle 保持一致）
function sessionTitle(task: string): string {
  return task.replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名任务';
}

export default function App() {
  const [themeMode, setThemeMode] = useThemeMode();
  const {
    permissionMode,
    setPermissionMode,
    language,
    setLanguage,
    fontSize,
    setFontSize,
  } = useGeneralSettings();
  const [runs, setRuns] = useState<HostRun[]>([]);
  const [sessions, setSessions] = useState<HostSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [, setFiles] = useState<FileEntry[]>([]);
  const [viewingFile, setViewingFile] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarUserOverrideRef = useRef(false);
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [resumingRun, setResumingRun] = useState(false);
  const [preferredWorkspaceName, setPreferredWorkspaceName] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defaultModel, setDefaultModelState] = useState<DefaultModelView | null>(null);
  const [models, setModels] = useState<ModelProviderView[]>([]);
  const previousDefaultModelRef = useRef<DefaultModelView | null>(null);
  const modelSaveVersionRef = useRef(0);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  const handleSelectModel = useCallback((providerId: string, model: string) => {
    const previous = previousDefaultModelRef.current ?? { defaultProviderId: "", defaultModelId: "" };
    const next = { defaultProviderId: providerId, defaultModelId: model };
    setDefaultModelState(next);
    previousDefaultModelRef.current = next;

    const version = ++modelSaveVersionRef.current;
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
      });
  }, [showToast]);

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

  const refreshDefaultModel = useCallback(async () => {
    try {
      const resp = await getDefaultModel();
      setDefaultModelState({
        defaultProviderId: resp.defaultProviderId,
        defaultModelId: resp.defaultModelId,
      });
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

  const refreshSessions = useCallback(async (mode: 'merge' | 'replace' = 'merge'): Promise<HostSession[]> => {
    try {
      const sessionResp = await listSessions();
      // merge：与乐观插入的 sessions 合并，服务端同 sessionId 项优先（title/workspace 以服务端为准）；
      // replace：以服务端为准整体替换（删除工作区后必须换，否则被删会话残留前端）。
      if (mode === 'replace') {
        setSessions(sessionResp.sessions);
      } else {
        setSessions(prev => {
          const byId = new Map(prev.map(s => [s.sessionId, s]));
          for (const s of sessionResp.sessions) byId.set(s.sessionId, s);
          return Array.from(byId.values());
        });
      }
      return sessionResp.sessions;
    } catch (err) {
      console.error('Failed to refresh sessions:', err);
      throw err;
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
    void refreshSessions();
    getWorkspace().then(resp => setWorkspace(resp.workspace)).catch(() => {});
    void refreshModels();
    void refreshDefaultModel();
  }, [refreshRuns, refreshSessions, refreshModels, refreshDefaultModel]);

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

  const currentRun = runs.find(r => r.runId === currentRunId) ?? null;
  const currentSession = sessions.find(s => s.sessionId === currentSessionId) ?? null;

  // 下拉的当前选择 = 默认模型对 + provider 目录派生；目录未加载或对不上时显示占位
  const currentModelSelection: ModelSelection | null = (() => {
    if (!defaultModel?.defaultProviderId) return null;
    const provider = models.find(m => m.id === defaultModel.defaultProviderId);
    if (!provider) return null;
    const model = defaultModel.defaultModelId && provider.models.includes(defaultModel.defaultModelId)
      ? defaultModel.defaultModelId
      : provider.models[0];
    if (!model) return null;
    return { providerId: provider.id, providerName: provider.name, model };
  })();
  const currentSessionRuns = runs
    .filter(run => run.sessionId === currentSessionId)
    .sort((a, b) => a.turnIndex - b.turnIndex);

  // Poll run files (kept for future "附件" row; not displayed inline).
  useEffect(() => {
    if (!currentRunId) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    listFiles(currentRunId)
      .then(resp => {
        if (!cancelled) setFiles(resp.files);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentRunId, currentRun?.status]);

  const handleCreateRun = useCallback(async (task: string) => {
    const trimmed = task.trim();
    if (!trimmed) return;
    try {
      const resp = await createRun(
        trimmed,
        currentSessionId ?? undefined,
        preferredWorkspaceName ?? undefined,
        permissionMode,
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        permissionMode: resp.permissionMode,
      };
      setCurrentSessionId(resp.sessionId);
      setCurrentRunId(resp.runId);
      setRuns(prev => {
        if (prev.some(r => r.runId === optimisticRun.runId)) return prev;
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
        setSessions(prev => {
          if (prev.some(s => s.sessionId === optimisticSession.sessionId)) return prev;
          return [optimisticSession, ...prev];
        });
      }
      // Session 列表与 Run 状态解耦；仅新建会话后做一次服务端同步。
      if (isNewSession) void refreshSessions();
      setPreferredWorkspaceName(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to create run:', err);
      alert(`任务创建失败：${msg}`);
    }
  }, [currentSessionId, currentSessionRuns.length, permissionMode, preferredWorkspaceName, refreshSessions, workspace]);

  const handleRunTerminal = useCallback(() => {
    // SSE 已携带终态；这里只做一次持久化状态对账，不启动后台轮询。
    void refreshRuns();
  }, [refreshRuns]);

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

  const handleSelectSession = useCallback((sessionId: string) => {
    const sessionRuns = runs
      .filter(run => run.sessionId === sessionId)
      .sort((a, b) => b.turnIndex - a.turnIndex);
    setCurrentSessionId(sessionId);
    setCurrentRunId(sessionRuns[0]?.runId ?? null);
    setViewingFile(null);
  }, [runs]);

  // TurnNavigator：点击/键盘选择某个历史回合 → 切换查看该 run 并滚动到对应 Timeline
  const handleNavigateRun = useCallback((runId: string) => {
    setCurrentRunId(runId);
    // 等当前 Run 渲染后滚动（setState 异步，延迟一帧）
    requestAnimationFrame(() => {
      document.getElementById(`run-${runId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const handleNewTask = useCallback(() => {
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

  const handleRenameWorkspace = useCallback(async (fromName: string, toName: string) => {
    try {
      await apiRenameWorkspace(fromName, toName);
      setWorkspace(w => (w && w.name === fromName ? { name: toName } : w));
      await refreshSessions('replace');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`重命名失败：${msg}`);
    }
  }, [refreshSessions]);

  const handleDeleteWorkspace = useCallback(async (name: string) => {
    try {
      await deleteWorkspaceGroup(name);
      setWorkspace(w => (w && w.name === name ? null : w));
      const remaining = await refreshSessions('replace');
      setSessions(remaining);
      // 当前会话所属工作区被删除 → 回到 landing
      if (currentSessionId && !remaining.some(s => s.sessionId === currentSessionId)) {
        setCurrentSessionId(null);
        setCurrentRunId(null);
        setViewingFile(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`删除工作区失败：${msg}`);
    }
  }, [currentSessionId, refreshSessions]);

  const handleRenameSession = useCallback(async (sessionId: string, title: string) => {
    try {
      await apiRenameSession(sessionId, title);
      setSessions(prev => prev.map(s => s.sessionId === sessionId ? { ...s, title, updatedAt: new Date().toISOString() } : s));
      showToast('重命名成功');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`重命名失败：${msg}`);
    }
  }, [showToast]);

  const handleArchiveSession = useCallback(async (sessionId: string) => {
    try {
      await apiArchiveSession(sessionId);
      // 乐观更新：立即从列表移除，避免用户看到“什么都没发生”
      setSessions(prev => prev.filter(s => s.sessionId !== sessionId));
      if (currentSessionId === sessionId) {
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
  }, [currentSessionId, refreshSessions, showToast]);

  const handleOpenWorkspace = useCallback(async () => {
    if (openingWorkspace) return;
    setOpeningWorkspace(true);
    try {
      const resp = await openWorkspace();
      if (!resp.cancelled) setWorkspace(resp.workspace);
    } catch (err) {
      console.error('Failed to open workspace:', err);
    } finally {
      setOpeningWorkspace(false);
    }
  }, [openingWorkspace]);

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
          setSidebarCollapsed(value => !value);
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
        />

        {currentSessionId ? (
          <div className={styles.workspace}>
            <div className={styles.sessionTimeline}>
              {/* 0 高 sticky 槽必须挂在滚动容器内部，rail 才能钉在可视带右缘 */}
              <TurnNavigator
                runs={currentSessionRuns}
                activeRunId={currentRunId}
                onNavigate={handleNavigateRun}
              />
              {currentSessionRuns.length > 0 ? (
                currentSessionRuns.map((run, index) => (
                  <Timeline
                    key={run.runId}
                    run={run}
                    modelFallback={null}
                    embedded
                    onRunTerminal={handleRunTerminal}
                    onRetryCommand={handleCreateRun}
                  />
                ))
              ) : (
                <div className={styles.sessionTimelineEmpty}>
                  <p>正在准备工作区…</p>
                </div>
              )}
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
              permissionMode={permissionMode}
              onSelectPermission={setPermissionMode}
            />
          </div>
        )}

        {currentSessionId && currentRun && (
          <InputBar
            onSend={handleCreateRun}
            onStop={handleStopRun}
            isRunning={currentRun.status === 'running'}
            isStopping={currentRun.status === 'stopping'}
            placeholder="发消息或做任务... / 调用指令 @ 文件或对话"
            disabled={currentRun.status === 'running'}
            currentModel={currentModelSelection ?? undefined}
            models={models}
            onSelectModel={handleSelectModel}
            permissionMode={permissionMode}
            onSelectPermission={setPermissionMode}
          />
        )}
      </div>

      {viewingFile && currentRunId && (
        <FileModal
          runId={currentRunId}
          file={viewingFile}
          onClose={() => setViewingFile(null)}
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
