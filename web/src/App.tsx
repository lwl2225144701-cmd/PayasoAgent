import { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ShellBar } from './components/ShellBar';
import { Timeline } from './components/Timeline';
import { InputBar } from './components/InputBar';
import { FileModal } from './components/FileModal';
import {
  createRun,
  deleteWorkspaceGroup,
  getWorkspace,
  listRuns,
  listSessions,
  listFiles,
  openWorkspace,
  renameWorkspace as apiRenameWorkspace,
  renameSession as apiRenameSession,
  archiveSession as apiArchiveSession,
  restoreSession as apiRestoreSession,
  deleteSession as apiDeleteSession,
  resumeRun,
  stopRun,
} from './api';
import type { FileEntry, HostRun, HostSession, WorkspaceView } from './types';
import styles from './App.module.css';

// 与会话标题生成规则（与 src/host/run-manager.ts sessionTitle 保持一致）
function sessionTitle(task: string): string {
  return task.replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名任务';
}

export default function App() {
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
  }, [refreshRuns, refreshSessions]);

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

  const currentRun = runs.find(r => r.runId === currentRunId) ?? null;
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
  }, [currentSessionId, currentSessionRuns.length, preferredWorkspaceName, refreshSessions, workspace]);

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

  const handleNewTask = useCallback(() => {
    setCurrentRunId(null);
    setCurrentSessionId(null);
    setViewingFile(null);
    setPreferredWorkspaceName(null);
    setTimeout(() => {
      const input = document.querySelector('textarea');
      input?.focus();
    }, 50);
  }, []);

  const handleNewTaskInWorkspace = useCallback((workspaceName: string) => {
    // 切到 landing 并记住目标工作区；用户提交任务时 createRun 会带上 workspaceName，
    // 后端新建会话并继承该工作区根目录（会话创建后清空偏好）。
    setPreferredWorkspaceName(workspaceName);
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
    await apiRenameSession(sessionId, title);
    setSessions(prev => prev.map(s => s.sessionId === sessionId ? { ...s, title, updatedAt: new Date().toISOString() } : s));
  }, []);

  const handleArchiveSession = useCallback(async (sessionId: string) => {
    await apiArchiveSession(sessionId);
    await refreshSessions('replace');
    if (currentSessionId === sessionId) {
      setCurrentSessionId(null);
      setCurrentRunId(null);
      setViewingFile(null);
    }
  }, [currentSessionId, refreshSessions]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    await apiDeleteSession(sessionId);
    await refreshSessions('replace');
    if (currentSessionId === sessionId) {
      setCurrentSessionId(null);
      setCurrentRunId(null);
      setViewingFile(null);
    }
  }, [currentSessionId, refreshSessions]);

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
        onDeleteSession={handleDeleteSession}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => {
          sidebarUserOverrideRef.current = true;
          setSidebarCollapsed(value => !value);
        }}
        workspace={workspace}
        openingWorkspace={openingWorkspace}
        onOpenWorkspace={handleOpenWorkspace}
      />

      <div className={styles.main}>
        <ShellBar run={currentRun} onResume={handleResumeRun} resuming={resumingRun} />

        {currentSessionId ? (
          <div className={styles.workspace}>
            <div className={styles.sessionTimeline}>
              {currentSessionRuns.length > 0 ? (
                currentSessionRuns.map((run, index) => (
                  <Timeline
                    key={run.runId}
                    run={run}
                    modelFallback={null}
                    embedded
                    showFiles={index === currentSessionRuns.length - 1}
                    onRunTerminal={handleRunTerminal}
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
            />
          </div>
        )}

        {currentSessionId && currentRun && (
          <InputBar
            onSend={handleCreateRun}
            onStop={handleStopRun}
            isRunning={currentRun.status === 'running'}
            placeholder="输入任务…"
            disabled={currentRun.status === 'running'}
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
    </div>
  );
}
