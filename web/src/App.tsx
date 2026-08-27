import { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ShellBar } from './components/ShellBar';
import { Timeline } from './components/Timeline';
import { InputBar } from './components/InputBar';
import { FileModal } from './components/FileModal';
import { useEventStream } from './hooks/useEventStream';
import { createRun, getWorkspace, listRuns, listFiles, openWorkspace, resumeRun, stopRun } from './api';
import type { FileEntry, HostRun, WorkspaceView } from './types';
import styles from './App.module.css';

export default function App() {
  const [runs, setRuns] = useState<HostRun[]>([]);
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

  const { events } = useEventStream(currentRunId);

  const refreshRuns = useCallback(async () => {
    try {
      const resp = await listRuns();
      setRuns(resp.runs);
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

  // Refresh run list when the stream reaches a terminal event
  useEffect(() => {
    if (!currentRunId || events.length === 0) return;
    const lastEvent = events[events.length - 1];
    if (lastEvent.type === 'run_completed' || lastEvent.type === 'run_failed' || lastEvent.type === 'run_stopped' || lastEvent.type === 'run_interrupted') {
      refreshRuns();
    }
  }, [events, currentRunId, refreshRuns]);

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
    try {
      const resp = await createRun(task);
      setCurrentRunId(resp.runId);
      refreshRuns();
    } catch (err) {
      console.error('Failed to create run:', err);
    }
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

  const handleSelectRun = useCallback((runId: string) => {
    setCurrentRunId(runId);
    setViewingFile(null);
  }, []);

  const handleNewTask = useCallback(() => {
    setCurrentRunId(null);
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
        runs={runs}
        currentRunId={currentRunId}
        onSelectRun={handleSelectRun}
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

        {currentRun ? (
          <div className={styles.workspace}>
            <Timeline
              run={currentRun}
              modelFallback={null}
            />
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

        {currentRun && (
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
