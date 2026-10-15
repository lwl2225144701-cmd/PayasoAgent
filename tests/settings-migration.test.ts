// 模块: legacy 明文 apiKey 迁移（Case 6/7/8：先写 SecretStore 再剥 SQLite、幂等、失败不丢 key）+
//       SettingsStore 跨存储补偿（Case A/B/C：SecretStore 与 metadata 双向失败回滚、
//       默认引用即时清空、陈旧 hasApiKey 自愈）测试
// 用法: npx tsx tests/settings-migration.test.ts（确定性，无真实网络；SecretStore = Memory）
// 来源: 自原 tests/settings.test.ts 按测试域拆出，用例原样搬移（未改任何测试逻辑与断言）。

import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SettingsStore } from '../src/host/persistence/settings-store.js';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import { MemorySecretStore, providerSecretKey } from '../src/host/secrets/secret-store.js';
import { check, ROOT, reportAndExit } from './helpers/settings-harness.js';

// ---- 测试开始 ----

(async () => {
  // 27. Case 6/7/8: legacy 明文 apiKey 迁移（先写 SecretStore 再剥 SQLite；幂等；失败不丢 key）
  {
    const legacyDbPath = path.join(ROOT, 'legacy-secrets.db');
    const legacy = new DatabaseSync(legacyDbPath);
    legacy.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    legacy.prepare("INSERT INTO settings VALUES ('app', ?)").run(
      JSON.stringify({
        models: [
          {
            id: 'legacy-p1',
            kind: 'custom',
            name: 'LegacyOne',
            baseUrl: 'https://legacy1.example.com',
            apiKey: 'legacy-secret-one',
            hasApiKey: true,
            models: ['l1'],
          },
          {
            id: 'legacy-p2',
            kind: 'custom',
            name: 'LegacyTwo',
            baseUrl: 'https://legacy2.example.com',
            apiKey: '',
            hasApiKey: false,
            models: ['l2'],
          },
        ],
        defaultProviderId: 'legacy-p1',
        defaultModelId: 'l1',
      }),
    );
    legacy.close();

    // Case 6: 打开即迁移 → SecretStore 有值，SQLite 明文消失
    const mem = new MemorySecretStore();
    let _firstSetCalls = 0;
    const store = new SqliteRunStore(legacyDbPath, {
      get: (k: string) => mem.get(k),
      set: (k: string, v: string) => {
        _firstSetCalls++;
        mem.set(k, v);
      },
      delete: (k: string) => {
        mem.delete(k);
      },
    });
    check(
      'Case6: legacy secret migrated to SecretStore',
      mem.get(providerSecretKey('legacy-p1')) === 'legacy-secret-one',
    );
    // 必须真读到 settings 行：缺行 = 迁移没落库，这里要硬失败；
    // 否则 String(undefined) === 'undefined' 会让下面的检查假通过。
    const appRow = new DatabaseSync(legacyDbPath)
      .prepare("SELECT value FROM settings WHERE key='app'")
      .get() as { value?: string } | undefined;
    assert.ok(appRow?.value !== undefined, 'settings 表缺少 key=app 行（迁移未落库）');
    const rawBlob = String(appRow.value);
    check('Case6: legacy plaintext removed from SQLite', !rawBlob.includes('legacy-secret-one'));
    check(
      'Case6: empty legacy key → no secret created',
      mem.get(providerSecretKey('legacy-p2')) === null,
    );
    check(
      'Case6: migrated provider usable',
      store.listModelProviders().some((p: any) => p.id === 'legacy-p1' && p.hasApiKey === true),
    );
    store.close();

    // Case 8: 幂等 —— 二次打开 0 次 Secret 写入
    let secondSetCalls = 0;
    const store2 = new SqliteRunStore(legacyDbPath, {
      get: (k: string) => mem.get(k),
      set: (k: string, v: string) => {
        secondSetCalls++;
        mem.set(k, v);
      },
      delete: (k: string) => {
        mem.delete(k);
      },
    });
    store2.close();
    check(
      'Case8: second open is a no-op (0 secret writes)',
      secondSetCalls === 0,
      `setCalls=${secondSetCalls}`,
    );

    // Case 7: SecretStore.set 失败 → legacy 明文不被删除（凭证不丢）
    const failingDb = path.join(ROOT, 'failing-secrets.db');
    const flegacy = new DatabaseSync(failingDb);
    flegacy.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    flegacy.prepare("INSERT INTO settings VALUES ('app', ?)").run(
      JSON.stringify({
        models: [
          {
            id: 'f-p',
            kind: 'custom',
            name: 'F',
            baseUrl: 'https://f.example.com',
            apiKey: 'legacy-secret-must-survive',
            hasApiKey: true,
            models: ['f1'],
          },
        ],
        defaultProviderId: 'f-p',
        defaultModelId: 'f1',
      }),
    );
    flegacy.close();
    assert.throws(
      () =>
        new SettingsStore(new DatabaseSync(failingDb), {
          get: () => null,
          set: () => {
            throw new Error('keychain boom');
          },
          delete: () => {},
        }),
    );
    // 同上：读不到行就硬失败，否则"明文仍在"这条检查会在 undefined 上假通过
    const rowAfterFailure = new DatabaseSync(failingDb)
      .prepare("SELECT value FROM settings WHERE key='app'")
      .get() as { value?: string } | undefined;
    assert.ok(rowAfterFailure?.value !== undefined, 'settings 表缺少 key=app 行');
    const rawAfterFailure = String(rowAfterFailure.value);
    check(
      'Case7: legacy apiKey NOT deleted when SecretStore.set fails',
      rawAfterFailure.includes('legacy-secret-must-survive'),
    );
  }

  // 30. SettingsStore 补偿：add/update/delete 的跨存储一致性
  // 两类真实故障注入：
  //   (a) SecretStore 本身失败（failNext）
  //   (b) metadata 写入失败（SQLite BEFORE UPDATE 触发器 RAISE(ABORT)）—— Secret 已成功写入后的补偿回滚
  {
    const failingSecretStore = new (class extends MemorySecretStore {
      failNext = false;
      set(key: string, value: string): void {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('secret store boom');
        }
        super.set(key, value);
      }
      delete(key: string): void {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('secret store boom');
        }
        super.delete(key);
      }
    })();

    // 在 settings 表上安装 BEFORE UPDATE 触发器：任何 metadata 写入都 RAISE(ABORT)
    function addMetaWriteFailTrigger(db: DatabaseSync): void {
      db.exec(`CREATE TRIGGER fail_meta_write BEFORE UPDATE ON settings
               BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END`);
    }

    // Case A1: SecretStore.set 失败 → addModel 抛错，无孤儿 secret
    {
      const db = new DatabaseSync(path.join(ROOT, 'fail-add-secret.db'));
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db.exec(
        'INSERT INTO settings (key, value) VALUES (\'app\', \'{"models":[],"defaultProviderId":"","defaultModelId":""}\')',
      );
      const store = new SettingsStore(db, failingSecretStore);
      failingSecretStore.failNext = true;
      try {
        store.addModel({
          name: 'FailAddSecret',
          baseUrl: 'https://fail.add.secret',
          apiKey: 'sk-fail-add',
          models: ['m'],
        });
      } catch {
        // expected
      }
      check(
        'Compensation A1: secret set failure leaves no orphan secret',
        !failingSecretStore.get('model-provider:fail-add-secret:api-key') &&
          failingSecretStore.get('model-provider:fail-add-secret:api-key') === null,
      );
    }

    // Case A2: SecretStore.set 成功 + metadata 写失败（触发器）→ 补偿删除 Secret
    {
      const db = new DatabaseSync(path.join(ROOT, 'fail-add-meta.db'));
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db.exec(
        'INSERT INTO settings (key, value) VALUES (\'app\', \'{"models":[],"defaultProviderId":"","defaultModelId":""}\')',
      );
      const store = new SettingsStore(db, failingSecretStore); // 构造函数迁移完成后才能装触发器
      addMetaWriteFailTrigger(db);
      const idBefore = JSON.parse(
        (db.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string }).value,
      ).models.length;
      try {
        store.addModel({
          name: 'FailAddMeta',
          baseUrl: 'https://fail.add.meta',
          apiKey: 'sk-fail-add',
          models: ['m'],
        });
        check('Compensation A2: metadata failure throws', false, 'expected throw');
      } catch {
        check('Compensation A2: metadata failure throws', true);
      }
      // Secret 必须被补偿删除（真实命中"写入成功 → metadata 失败 → 回滚"路径）
      check(
        'Compensation A2: orphan secret compensated',
        failingSecretStore.get('model-provider:fail-add-meta:api-key') === null,
        `got ${JSON.stringify(failingSecretStore.get('model-provider:fail-add-meta:api-key'))}`,
      );
      const row = db.prepare("SELECT value FROM settings WHERE key='app'").get() as
        | { value: string }
        | undefined;
      check(
        'Compensation A2: metadata unchanged',
        row ? JSON.parse(row.value).models.length === idBefore : false,
      );
    }

    // Case B1: SecretStore.set 失败 → updateModel 抛错，secret 保持旧值
    {
      const db2 = new DatabaseSync(path.join(ROOT, 'fail-update-secret.db'));
      db2.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db2.exec(
        'INSERT INTO settings (key, value) VALUES (\'app\', \'{"models":[{"id":"up1","name":"Up1","baseUrl":"https://up1","hasApiKey":true,"models":["m"],"kind":"custom"}],"defaultProviderId":"","defaultModelId":""}\')',
      );
      const store2 = new SettingsStore(db2, failingSecretStore);
      failingSecretStore.set('model-provider:up1:api-key', 'old-secret');
      failingSecretStore.failNext = true;
      try {
        store2.updateModel('up1', { name: 'Up1Renamed', apiKey: 'new-secret' });
      } catch {
        // expected
      }
      check(
        'Compensation B1: secret write failure keeps old secret',
        failingSecretStore.get('model-provider:up1:api-key') === 'old-secret',
      );
    }

    // Case B2: 新 Secret 写入成功 + metadata 写失败（触发器）→ 恢复旧 Secret
    {
      const db2 = new DatabaseSync(path.join(ROOT, 'fail-update-meta.db'));
      db2.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db2.exec(
        'INSERT INTO settings (key, value) VALUES (\'app\', \'{"models":[{"id":"up2","name":"Up2","baseUrl":"https://up2","hasApiKey":true,"models":["m"],"kind":"custom"}],"defaultProviderId":"","defaultModelId":""}\')',
      );
      const store2 = new SettingsStore(db2, failingSecretStore); // 先构造，后装触发器
      addMetaWriteFailTrigger(db2);
      failingSecretStore.set('model-provider:up2:api-key', 'old-secret');
      try {
        store2.updateModel('up2', { name: 'Up2Renamed', apiKey: 'new-secret' });
        check('Compensation B2: metadata failure throws', false, 'expected throw');
      } catch {
        check('Compensation B2: metadata failure throws', true);
      }
      // 新 Secret 写入后 metadata 失败 → 必须回滚到旧 Secret（真实命中回滚路径）
      check(
        'Compensation B2: secret rolled back to old',
        failingSecretStore.get('model-provider:up2:api-key') === 'old-secret',
        `got ${JSON.stringify(failingSecretStore.get('model-provider:up2:api-key'))}`,
      );
      // 默认引用检查在 hasApiKey 更新后执行：清空默认 provider 凭证必须立即清空默认引用
      check(
        'Compensation B2: default reference not dangling',
        JSON.parse(
          (db2.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string })
            .value,
        ).defaultProviderId === '',
      );
    }

    // Case B3: 默认 provider 被清空凭证（apiKey: null）→ 默认引用必须立即清空（顺序修复回归）
    {
      const db2 = new DatabaseSync(path.join(ROOT, 'default-clear-api-key.db'));
      db2.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db2.exec(
        'INSERT INTO settings (key, value) VALUES (\'app\', \'{"models":[{"id":"dp1","name":"DP1","baseUrl":"https://dp1","hasApiKey":true,"models":["m1"],"kind":"custom"}],"defaultProviderId":"dp1","defaultModelId":"m1"}\')',
      );
      const store2 = new SettingsStore(db2, failingSecretStore);
      failingSecretStore.set('model-provider:dp1:api-key', 'dp-secret');
      const updated = store2.updateModel('dp1', { apiKey: null });
      check('Default-clear: update returns hasApiKey=false', updated?.hasApiKey === false);
      const row = db2.prepare("SELECT value FROM settings WHERE key='app'").get() as
        | { value: string }
        | undefined;
      const parsed = row
        ? JSON.parse(row.value)
        : { defaultProviderId: 'dp1', defaultModelId: 'm1' };
      check(
        'Default-clear: defaultProviderId cleared',
        parsed.defaultProviderId === '',
        `got ${JSON.stringify(parsed.defaultProviderId)}`,
      );
      check(
        'Default-clear: defaultModelId cleared',
        parsed.defaultModelId === '',
        `got ${JSON.stringify(parsed.defaultModelId)}`,
      );
      check(
        'Default-clear: secret deleted',
        failingSecretStore.get('model-provider:dp1:api-key') === null,
      );
    }

    // Case B4: 元数据残留 hasApiKey=true 但 SecretStore 已无密钥 → 保存时自愈，不再阻塞用户
    {
      const db2 = new DatabaseSync(path.join(ROOT, 'stale-api-key-metadata.db'));
      db2.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db2.exec(
        'INSERT INTO settings (key, value) VALUES (\'app\', \'{"models":[{"id":"stale1","name":"Stale","baseUrl":"https://stale","hasApiKey":true,"models":["m"],"kind":"custom"}],"defaultProviderId":"stale1","defaultModelId":"m"}\')',
      );
      const store2 = new SettingsStore(db2, new MemorySecretStore());
      const updated = store2.updateModel('stale1', { name: 'Stale Renamed' });
      check('Stale credentials: metadata edit succeeds', updated?.name === 'Stale Renamed');
      check('Stale credentials: hasApiKey repaired', updated?.hasApiKey === false);
      check(
        'Stale credentials: default reference cleared',
        JSON.parse(
          (db2.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string })
            .value,
        ).defaultProviderId === '',
      );
      db2.close();
    }

    // Case C1: SecretStore.delete 失败 → metadata 不被删除（防止 orphan secret）
    {
      const db3 = new DatabaseSync(path.join(ROOT, 'fail-delete-secret.db'));
      db3.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      const json = JSON.stringify({
        models: [
          {
            id: 'del1',
            name: 'Del1',
            baseUrl: 'https://del1',
            hasApiKey: true,
            models: ['m'],
            kind: 'custom',
          },
        ],
        defaultProviderId: '',
        defaultModelId: '',
      });
      db3.exec(`INSERT INTO settings (key, value) VALUES ('app', '${json}')`);
      const store3 = new SettingsStore(db3, failingSecretStore);
      failingSecretStore.set('model-provider:del1:api-key', 'del-secret');
      failingSecretStore.failNext = true;
      try {
        store3.deleteModel('del1');
      } catch {
        // expected
      }
      const afterRow = db3.prepare("SELECT value FROM settings WHERE key='app'").get() as
        | { value: string }
        | undefined;
      const after = afterRow ? JSON.parse(afterRow.value) : { models: [] };
      check('Compensation C1: secret delete failure preserves metadata', after.models.length === 1);
    }

    // Case C2: Secret 删除成功 + metadata 写失败（触发器）→ 恢复 Secret
    {
      const db3 = new DatabaseSync(path.join(ROOT, 'fail-delete-meta.db'));
      db3.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      const json = JSON.stringify({
        models: [
          {
            id: 'del2',
            name: 'Del2',
            baseUrl: 'https://del2',
            hasApiKey: true,
            models: ['m'],
            kind: 'custom',
          },
        ],
        defaultProviderId: '',
        defaultModelId: '',
      });
      db3.exec(`INSERT INTO settings (key, value) VALUES ('app', '${json}')`);
      const store3 = new SettingsStore(db3, failingSecretStore); // 先构造，后装触发器
      addMetaWriteFailTrigger(db3);
      failingSecretStore.set('model-provider:del2:api-key', 'del-secret');
      try {
        store3.deleteModel('del2');
        check('Compensation C2: metadata failure throws', false, 'expected throw');
      } catch {
        check('Compensation C2: metadata failure throws', true);
      }
      // Secret 删除后 metadata 失败 → 必须恢复 Secret（真实命中恢复路径）
      check(
        'Compensation C2: secret restored after metadata failure',
        failingSecretStore.get('model-provider:del2:api-key') === 'del-secret',
        `got ${JSON.stringify(failingSecretStore.get('model-provider:del2:api-key'))}`,
      );
      const row = db3.prepare("SELECT value FROM settings WHERE key='app'").get() as
        | { value: string }
        | undefined;
      check(
        'Compensation C2: metadata preserved',
        row ? JSON.parse(row.value).models.length === 1 : false,
      );
    }
  }

  reportAndExit();
})();
