// 模块: Settings 域 handler —— /settings*（模型 Provider CRUD / 默认模型 / 可用模型目录）。
//
// 为什么单独存在：settings 域是所有资源域里分支最多的（pi-ai 目录、models CRUD、
// default、available-models、preview），且全部围绕「模型配置 + 凭证」语义。
// 从 routes.ts 拆出后该域有唯一 owner；凭证只从 RunManager 的 SecretStore 读，
// 绝不回显给浏览器（读 API 只回 hasApiKey/mask）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CreateModelProviderInput, UpdateModelProviderInput } from '../persistence/store.js';
import { listPiAiProviderCatalog } from '../pi-ai-providers.js';
import { canonicalizeProviderBaseUrl } from '../provider-url.js';
import type { RunManager } from '../run-manager.js';
import { fetchAvailableModelCatalog } from '../available-models.js';
import {
  MAX_BODY_BYTES,
  RequestBodyTooLargeError,
  bad,
  checkOrigin,
  notFound,
  readBody,
  requireAuth,
  requireJsonContentType,
  sendJson,
} from './route-context.js';

export async function handleSettings(
  s: string[],
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  port: number,
): Promise<void> {
  try {
    if (s.length === 3 && s[1] === 'pi-ai' && s[2] === 'providers' && method === 'GET') {
      // pi-ai 内置 Provider 的公开目录：只返回可选 Provider、模型能力和默认地址，
      // 不执行认证解析，也不把任何 API key 返回给浏览器。
      return sendJson(res, 200, { providers: listPiAiProviderCatalog() });
    }
    if (s.length === 2 && s[1] === 'models') {
      if (method === 'GET') {
        try {
          const views = manager.listModelProviders();
          return sendJson(res, 200, { models: views });
        } catch (err) {
          console.error('[settings] list models failed', err);
          return bad(res, 'list_models_failed');
        }
      }
      if (method === 'POST') {
        requireJsonContentType(req);
        checkOrigin(req, port);
        requireAuth(req);
        let body: CreateModelProviderInput;
        try {
          body = (await readBody(req)) as unknown as CreateModelProviderInput;
        } catch (err) {
          if (err instanceof RequestBodyTooLargeError) {
            return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
          }
          throw err;
        }
        try {
          if (
            typeof body.name !== 'string' ||
            (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') ||
            !Array.isArray(body.models)
          ) {
            return bad(res, 'invalid_request_body');
          }
          if (body.piProviderId !== undefined && typeof body.piProviderId !== 'string') {
            return bad(res, 'invalid_request_body');
          }
          const created = manager.addModelProvider(body);
          return sendJson(res, 201, created);
        } catch (err) {
          console.error('[settings] add model failed', err);
          return bad(res, (err as Error).message || 'add_model_failed');
        }
      }
      return notFound(res);
    }
    if (s.length === 3 && s[1] === 'models') {
      const id = s[2];
      // 仅接受 UUID（自定义 Provider 的 id 全部为 UUID；内置模板已移除）
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      if (!isUuid) {
        return bad(res, 'invalid_model_id');
      }
      if (method === 'PATCH') {
        requireJsonContentType(req);
        checkOrigin(req, port);
        requireAuth(req);
        let body: UpdateModelProviderInput;
        try {
          body = (await readBody(req)) as unknown as UpdateModelProviderInput;
        } catch (err) {
          if (err instanceof RequestBodyTooLargeError) {
            return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
          }
          throw err;
        }
        try {
          if (body.name !== undefined && typeof body.name !== 'string') {
            return bad(res, 'invalid_request_body');
          }
          if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') {
            return bad(res, 'invalid_request_body');
          }
          if (
            body.apiKey !== undefined &&
            body.apiKey !== null &&
            typeof body.apiKey !== 'string'
          ) {
            return bad(res, 'invalid_request_body');
          }
          if (body.models !== undefined && !Array.isArray(body.models)) {
            return bad(res, 'invalid_request_body');
          }
          const updated = manager.updateModelProvider(id, body);
          if (!updated) return notFound(res);
          return sendJson(res, 200, updated);
        } catch (err) {
          console.error('[settings] update model failed', err);
          return bad(res, (err as Error).message || 'update_model_failed');
        }
      }
      if (method === 'DELETE') {
        checkOrigin(req, port);
        requireAuth(req);
        const ok = manager.deleteModelProvider(id);
        if (!ok) return notFound(res);
        return sendJson(res, 200, { deleted: true });
      }
      return notFound(res);
    }
    if (s.length === 2 && s[1] === 'default' && method === 'POST') {
      requireJsonContentType(req);
      checkOrigin(req, port);
      requireAuth(req);
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch {
        return bad(res, 'invalid_request_body');
      }
      const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
      if (!providerId) return bad(res, 'providerId is required');
      // 未知 provider → 404；存在但未配置密钥/无模型/模型不在目录 → 400
      if (!manager.getModelProvider(providerId)) return notFound(res);
      const model = typeof body.model === 'string' ? body.model.trim() : undefined;
      if (model !== undefined && !model) return bad(res, 'model must be non-empty when provided');
      try {
        const result = manager.setDefaultModel(providerId, model);
        return sendJson(res, 200, {
          defaultProviderId: result.providerId,
          defaultModelId: result.modelId,
        });
      } catch (err) {
        return bad(res, (err as Error).message);
      }
    }
    if (s.length === 1 && s[0] === 'settings' && method === 'GET') {
      return sendJson(res, 200, {
        defaultProviderId: manager.getDefaultProviderId(),
        defaultModelId: manager.getDefaultModelId(),
      });
    }
    if (s.length === 2 && s[1] === 'available-models' && method === 'POST') {
      // 拉取 OpenAI 兼容端点的可用模型目录。凭证只来自服务端已保存配置，
      // 禁止客户端通过此接口外带 Secret 或指定任意 endpoint（SSRF 防线）。
      // 新增 Provider 时的临时预检走独立接口 /settings/available-models/preview。
      requireJsonContentType(req);
      checkOrigin(req, port);
      requireAuth(req);
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
          return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
        }
        throw err;
      }
      const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
      if (!providerId) return bad(res, 'providerId is required');
      const provider = manager.getModelProvider(providerId);
      if (!provider) return bad(res, 'provider not found or not configured');
      const secret = manager.getModelProviderSecret(providerId);
      if (!secret?.apiKey) return bad(res, 'provider has no API key configured');
      // 协议白名单 + 规范化：仅 https: 或本地 loopback http:（开发模式）
      let targetUrl: string;
      try {
        targetUrl = canonicalizeProviderBaseUrl(provider.baseUrl, { allowLoopbackHttp: true });
      } catch (err) {
        return bad(res, (err as Error).message || 'baseUrl protocol not allowed');
      }
      try {
        const catalog = await fetchAvailableModelCatalog(targetUrl, secret.apiKey);
        manager.recordModelProbe(providerId, { status: 'available' });
        return sendJson(res, 200, {
          models: catalog.map((model) => model.id),
          catalog,
        });
      } catch (err) {
        const message = (err as Error).message;
        manager.recordModelProbe(providerId, { status: 'error', error: message });
        return bad(res, message);
      }
    }
    if (
      s.length === 3 &&
      s[1] === 'available-models' &&
      s[2] === 'preview' &&
      method === 'POST'
    ) {
      // 新增 Provider 时的临时预检：用表单中的 baseUrl + apiKey 拉取模型目录。
      // 凭证不落盘、不进日志、不回显；仍受 fetchAvailableModelsSafe 保护
      // （协议白名单、凭证拒绝、loopback 限制、响应大小限制）。需鉴权。
      requireJsonContentType(req);
      checkOrigin(req, port);
      requireAuth(req);
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
          return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
        }
        throw err;
      }
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!baseUrl || !apiKey) return bad(res, 'baseUrl and apiKey are required');
      // 协议白名单 + 规范化：仅 https: 或本地 loopback http:（开发模式）
      let targetUrl: string;
      try {
        targetUrl = canonicalizeProviderBaseUrl(baseUrl, { allowLoopbackHttp: true });
      } catch (err) {
        return bad(res, (err as Error).message || 'baseUrl protocol not allowed');
      }
      try {
        const catalog = await fetchAvailableModelCatalog(targetUrl, apiKey);
        return sendJson(res, 200, {
          models: catalog.map((model) => model.id),
          catalog,
        });
      } catch (err) {
        return bad(res, (err as Error).message);
      }
    }
    return notFound(res);
  } catch (err) {
    if (err instanceof Error && err.message === 'untrusted origin') {
      return bad(res, 'untrusted origin');
    }
    if (err instanceof Error && err.message === 'missing or invalid authorization') {
      return bad(res, 'missing or invalid authorization');
    }
    if (err instanceof Error && err.message === 'Content-Type must be application/json') {
      return bad(res, 'invalid_content_type');
    }
    throw err;
  }
}
