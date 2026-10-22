// Full access 仍使用 WRITE_RESTRICTED 令牌，但第二道写检查改用当前用户已有身份。
// 不调用 AclSandbox，不加目录 ACE，也不把完整性降到 Low。
// 见 docs/plans/windows-full-access-token-plan.md。

import {
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodeUint32,
  extendWin32ProcessBindings,
  spawnInheritedJobProcess,
  throwLastError,
  waitForProcessExit,
} from '@deepseek-ai/dsh-win32-process';
import koffi from 'koffi';

const PROCESS_QUERY_INFORMATION = 0x0400;
const TOKEN_ASSIGN_PRIMARY = 0x0001;
const TOKEN_DUPLICATE = 0x0002;
const TOKEN_QUERY = 0x0008;
const DISABLE_MAX_PRIVILEGE = 0x1;
const LUA_TOKEN = 0x4;
const WRITE_RESTRICTED = 0x8;
const TokenUser = 1;
const TokenGroups = 2;
const WinWorldSid = 1;
const SE_GROUP_LOGON_ID = 0xc0000000;
const SE_GROUP_ENABLED = 0x00000004;
const SE_GROUP_USE_FOR_DENY_ONLY = 0x00000010;
const SECURITY_MAX_SID_SIZE = 68;
const SID_AND_ATTRIBUTES_SIZE = 16;
const TOKEN_GROUPS_OFFSET = 8;
const LPTR = 0x0040;

let api;

function bindings() {
  if (api) return api;
  api = extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({
    openProcess: bind(kernel32, 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']),
    openProcessToken: bind(advapi32, 'OpenProcessToken', 'int', ['void *', 'uint32', 'void **']),
    localAlloc: bind(kernel32, 'LocalAlloc', 'void *', ['uint32', 'size_t']),
    getLengthSid: bind(advapi32, 'GetLengthSid', 'uint32', ['void *']),
    copySid: bind(advapi32, 'CopySid', 'int', ['uint32', 'void *', 'void *']),
    createWellKnownSid: bind(advapi32, 'CreateWellKnownSid', 'int', [
      'int',
      'void *',
      'void *',
      koffi.pointer('uint32'),
    ]),
    isValidSid: bind(advapi32, 'IsValidSid', 'int', ['void *']),
    getTokenInformation: bind(advapi32, 'GetTokenInformation', 'int', [
      'void *',
      'int',
      'void *',
      'uint32',
      koffi.pointer('uint32'),
    ]),
    createRestrictedToken: bind(advapi32, 'CreateRestrictedToken', 'int', [
      'void *',
      'uint32',
      'uint32',
      'void *',
      'uint32',
      'void *',
      'uint32',
      'void *',
      'void **',
    ]),
    setEnvironmentVariable: bind(kernel32, 'SetEnvironmentVariableW', 'int', ['str16', 'str16']),
  }));
  return api;
}

function allocSid(win32, length) {
  const sid = win32.localAlloc(LPTR, length);
  if (sid === null || sid === 0n) throwLastError(win32, 'LocalAlloc', 'SID');
  return sid;
}

function copySid(win32, source) {
  const length = win32.getLengthSid(source);
  if (length === 0) throwLastError(win32, 'GetLengthSid', 'source SID');
  const dest = allocSid(win32, length);
  if (win32.copySid(length, dest, source) === 0) throwLastError(win32, 'CopySid', 'source SID');
  return dest;
}

function readGroups(win32, token) {
  const neededSlot = allocUint32();
  win32.getTokenInformation(token, TokenGroups, null, 0, neededSlot);
  const needed = decodeUint32(neededSlot);
  if (needed < TOKEN_GROUPS_OFFSET)
    throwLastError(win32, 'GetTokenInformation', 'TokenGroups size');
  const groups = Buffer.alloc(needed);
  if (win32.getTokenInformation(token, TokenGroups, groups, groups.length, neededSlot) === 0) {
    throwLastError(win32, 'GetTokenInformation', 'TokenGroups');
  }
  return groups;
}

function groupSid(groups, index) {
  const address = groups.readBigUInt64LE(TOKEN_GROUPS_OFFSET + index * SID_AND_ATTRIBUTES_SIZE);
  return address === 0n ? null : address;
}

function groupAttributes(groups, index) {
  return groups.readUInt32LE(TOKEN_GROUPS_OFFSET + index * SID_AND_ATTRIBUTES_SIZE + 8);
}

function findLogonSid(win32, token) {
  const groups = readGroups(win32, token);
  const count = groups.readUInt32LE(0);
  for (let index = 0; index < count; index++) {
    const attributes = groupAttributes(groups, index);
    const isLogon = (attributes & SE_GROUP_LOGON_ID) >>> 0 === SE_GROUP_LOGON_ID >>> 0;
    const sid = groupSid(groups, index);
    if (!isLogon || sid === null) continue;
    return copySid(win32, sid);
  }
  throw new Error('full-access token: no logon SID');
}

function userSid(win32, token) {
  const neededSlot = allocUint32();
  win32.getTokenInformation(token, TokenUser, null, 0, neededSlot);
  const needed = decodeUint32(neededSlot);
  if (needed === 0) throwLastError(win32, 'GetTokenInformation', 'TokenUser size');
  const buffer = Buffer.alloc(needed);
  if (win32.getTokenInformation(token, TokenUser, buffer, buffer.length, neededSlot) === 0) {
    throwLastError(win32, 'GetTokenInformation', 'TokenUser');
  }
  const address = buffer.readBigUInt64LE(0);
  if (address === 0n) throw new Error('full-access token: no user SID');
  return copySid(win32, address);
}

function enabledGroupSids(win32, token) {
  const groups = readGroups(win32, token);
  const count = groups.readUInt32LE(0);
  const sids = [];
  for (let index = 0; index < count; index++) {
    const attributes = groupAttributes(groups, index);
    if ((attributes & SE_GROUP_USE_FOR_DENY_ONLY) !== 0) continue;
    if ((attributes & SE_GROUP_ENABLED) === 0) continue;
    if ((attributes & SE_GROUP_LOGON_ID) >>> 0 === SE_GROUP_LOGON_ID >>> 0) continue;
    const sid = groupSid(groups, index);
    if (sid === null) continue;
    sids.push(copySid(win32, sid));
  }
  return sids;
}

function worldSid(win32) {
  const sid = Buffer.alloc(SECURITY_MAX_SID_SIZE);
  const sizeSlot = allocUint32();
  // CreateWellKnownSid writes the size through a uint32 pointer. allocUint32
  // is a native slot; pass its address via the binding's pointer parameter by
  // using a one-element heap buffer that koffi can take.
  const size = Buffer.alloc(4);
  size.writeUInt32LE(SECURITY_MAX_SID_SIZE, 0);
  if (win32.createWellKnownSid(WinWorldSid, null, sid, size) === 0) {
    throwLastError(win32, 'CreateWellKnownSid', 'Everyone');
  }
  void sizeSlot;
  if (win32.isValidSid(sid) === 0) throwLastError(win32, 'IsValidSid', 'Everyone');
  return sid;
}

function packRestrictingSids(sids) {
  const packed = Buffer.alloc(SID_AND_ATTRIBUTES_SIZE * sids.length);
  sids.forEach((sid, index) => {
    const address = typeof sid === 'bigint' ? sid : koffi.address(sid);
    packed.writeBigUInt64LE(BigInt(address), SID_AND_ATTRIBUTES_SIZE * index);
  });
  return packed;
}

function openCurrentToken(win32) {
  const processHandle = win32.openProcess(PROCESS_QUERY_INFORMATION, 0, process.pid);
  if (processHandle === null || processHandle === 0n) {
    throwLastError(win32, 'OpenProcess', `pid ${process.pid}`);
  }
  const tokenSlot = allocPtrSlot();
  const rights = TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY;
  const opened = win32.openProcessToken(processHandle, rights, tokenSlot);
  win32.closeHandle(processHandle);
  if (opened === 0) throwLastError(win32, 'OpenProcessToken', `pid ${process.pid}`);
  const token = decodePtr(tokenSlot);
  if (token === null) throw new Error('OpenProcessToken returned a null handle');
  return token;
}

function createToken(win32) {
  const current = openCurrentToken(win32);
  try {
    const restricting = [findLogonSid(win32, current), worldSid(win32), userSid(win32, current)];
    restricting.push(...enabledGroupSids(win32, current));
    const packed = packRestrictingSids(restricting);
    const createdSlot = allocPtrSlot();
    const flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
    const created = win32.createRestrictedToken(
      current,
      flags,
      0,
      null,
      0,
      null,
      restricting.length,
      packed,
      createdSlot,
    );
    if (created === 0) throwLastError(win32, 'CreateRestrictedToken', 'full-access');
    const token = decodePtr(createdSlot);
    if (token === null) throw new Error('CreateRestrictedToken returned a null handle');
    return token;
  } finally {
    win32.closeHandle(current);
  }
}

function inheritScratch(win32, scratch) {
  for (const name of ['HOME', 'TMP', 'TEMP', 'TMPDIR']) {
    if (win32.setEnvironmentVariable(name, scratch) === 0) {
      throwLastError(win32, 'SetEnvironmentVariableW', name);
    }
  }
}

/** 在「用户身份」受限令牌里执行一条命令。失败不启动不受限进程。 */
export async function runFullAccessRestricted(parsed) {
  const win32 = bindings();
  inheritScratch(win32, parsed.scratch);
  const token = createToken(win32);
  let execution = 'not_started';
  try {
    execution = 'unknown';
    const child = spawnInheritedJobProcess(win32, {
      command: parsed.command,
      args: parsed.args,
      cwd: parsed.workspace,
      token,
    });
    const exitCode = waitForProcessExit(win32, child.process);
    execution = 'completed';
    const cleanupErrors = [];
    if (win32.closeHandle(child.job) === 0) cleanupErrors.push('CloseHandle job failed');
    return { execution, exitCode, cleanupErrors };
  } catch (cause) {
    return {
      execution,
      exitCode: 127,
      error: cause instanceof Error ? cause.message : String(cause),
      cleanupErrors: [],
    };
  } finally {
    win32.closeHandle(token);
  }
}
