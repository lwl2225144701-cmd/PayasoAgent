import { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ShellBar } from './components/ShellBar';
import { Timeline } from './components/Timeline';
import { InputBar } from './components/InputBar';
import { FileModal } from './components/FileModal';
import { createRun, getWorkspace, listRuns, listSessions, listFiles, openWorkspace, resumeRun, stopRun } from './api';
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
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshRuns = useCallback(async () => {
    try {
      const [runResp, sessionResp] = await Promise.all([listRuns(), listSessions()]);
      setRuns(runResp.runs);
      // 与乐观插入的 sessions merge：服务端返回的同名 sessionId 项以服务端为准（title/workspace 可能和前端生成的不同）
      setSessions(prev => {
        const byId = new Map(prev.map(s => [s.sessionId, s]));
        for (const s of sessionResp.sessions) byId.set(s.sessionId, s);
        return Array.from(byId.values());
      });
      setOnline(true);
    } catch {
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshRuns();
    getWorkspace().then(resp => setWorkspace(resp.workspace)).catch(() => {});
    pollTimerRef.current = setInterval(refreshRuns, 2000);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [refreshRuns]);

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
      const resp = await createRun(trimmed, currentSessionId ?? undefined);
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
      // 后台再同步一次服务端最新状态，不阻塞 UI 切换
      void refreshRuns().catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to create run:', err);
      alert(`任务创建失败：${msg}`);
    }
  }, [currentSessionId, currentSessionRuns.length, refreshRuns, workspace]);

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
    setTimeout(() => {
      const input = document.querySelector('textarea');
      input?.focus();
    }, 50);
  }, []);

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
