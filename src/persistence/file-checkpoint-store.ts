// Default local checkpoint adapter. File paths, JSON encoding and atomic writes
// stay outside the Agent Runtime kernel.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  Checkpoint,
  CheckpointSnapshot,
  CheckpointWriter,
} from '../runtime/checkpoint-port.js';

const CHECKPOINT_DIR = path.join(process.cwd(), '.checkpoints');

export function checkpointPath(runId: string): string {
  return path.join(CHECKPOINT_DIR, `${runId}.json`);
}

export function saveCheckpoint(snapshot: CheckpointSnapshot): string {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const full: Checkpoint = { ...snapshot, savedAt: new Date().toISOString() };
  const file = checkpointPath(snapshot.runId);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(full, null, 2), 'utf-8');
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
  return file;
}

export const fileCheckpointWriter: CheckpointWriter = {
  save: saveCheckpoint,
};

export function loadCheckpoint(runId: string): Checkpoint | null {
  const file = checkpointPath(runId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Checkpoint;
  } catch {
    return null;
  }
}
