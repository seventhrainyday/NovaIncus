/**
 * 防滥用风控事件 API 路由（Phase 3）
 *
 * - POST /api/agent/abuse-event   agent 上报风控事件（HMAC agent 鉴权）
 * - GET  /api/admin/abuse-events  管理员分页查询风控事件
 * - POST /api/admin/abuse-events/:id/ack      管理员确认事件
 * - POST /api/admin/abuse-events/:id/unblock  管理员请求解封（记 log 待下发）
 *
 * TODO(wiring): 在 server/src/app.ts 注册本路由（注意：不要改动现有路由文件）：
 *   import abuseRoutes from './routes/abuse.js'
 *   await fastify.register(abuseRoutes)
 * 本文件内路由使用完整路径，因此注册时无需 prefix。
 *
 * 注意：agent 鉴权逻辑复刻自 server/src/routes/agent.ts 的
 * authenticateAgentRequest（使用 lib/agent-auth.js 导出的原语），
 * 保持签名算法与 nonce 防重放语义一致。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import { decryptSensitiveData } from '../lib/security.js'
import {
  agentNonceTtlMs,
  createAgentBodyHash,
  isAgentTimestampFresh,
  isValidAgentSecret,
  readAgentAuthHeaders,
  validateAgentHeaders,
  verifyAgentSignature
} from '../lib/agent-auth.js'
import {
  getAbuseEvent,
  listAbuseEvents,
  recordAbuseAdminOp,
  recordAbuseEvent,
  type AbuseEventInput
} from '../db/abuse.js'

const agentModel = prisma.hostAgent
const nonceModel = prisma.hostAgentNonce

type AgentIdentity = {
  hostId: number
  agentId: string
}

/**
 * Agent HMAC 鉴权（复刻自 agent.ts，保证行为一致）。
 * 成功返回 agent 身份，失败时已向客户端回复 401 并返回 null。
 */
async function authenticateAgent(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AgentIdentity | null> {
  const headers = readAgentAuthHeaders(request.headers)
  if (!headers) {
    reply.code(401).send({ error: 'Agent authentication headers are required', code: 'AGENT_AUTH_REQUIRED' })
    return null
  }

  const headerError = validateAgentHeaders(headers)
  if (headerError) {
    reply.code(401).send({ error: 'Invalid Agent authentication headers', code: 'AGENT_AUTH_INVALID', details: headerError })
    return null
  }

  if (!isAgentTimestampFresh(headers.timestamp)) {
    reply.code(401).send({ error: 'Agent request timestamp is expired', code: 'AGENT_AUTH_EXPIRED' })
    return null
  }

  const bodyHash = createAgentBodyHash((request as { body?: unknown }).body ?? {})
  if (bodyHash !== headers.bodyHash.toLowerCase()) {
    reply.code(401).send({ error: 'Agent body hash mismatch', code: 'AGENT_BODY_HASH_MISMATCH' })
    return null
  }

  const agent = await agentModel.findUnique({ where: { agentId: headers.agentId } })
  if (!agent || !agent.enabled) {
    reply.code(401).send({ error: 'Agent is not enabled', code: 'AGENT_DISABLED' })
    return null
  }

  const secret = decryptSensitiveData(agent.secretEncrypted)
  if (!secret || !isValidAgentSecret(secret)) {
    reply.code(401).send({ error: 'Agent secret is not available', code: 'AGENT_SECRET_INVALID' })
    return null
  }

  const requestPath = request.url.split('?')[0] || request.url
  const signatureOk = verifyAgentSignature(secret, {
    method: request.method,
    path: requestPath,
    timestamp: headers.timestamp,
    nonce: headers.nonce,
    bodyHash
  }, headers.signature)

  if (!signatureOk) {
    reply.code(401).send({ error: 'Agent signature verification failed', code: 'AGENT_SIGNATURE_INVALID' })
    return null
  }

  try {
    await prisma.$transaction([
      nonceModel.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
      nonceModel.create({
        data: {
          agentId: agent.agentId,
          nonce: headers.nonce,
          expiresAt: new Date(Date.now() + agentNonceTtlMs)
        }
      })
    ])
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      reply.code(401).send({ error: 'Agent nonce was already used', code: 'AGENT_NONCE_REPLAY' })
      return null
    }
    throw error
  }

  return { hostId: agent.hostId, agentId: agent.agentId }
}

function isValidAbuseEvent(value: unknown): value is AbuseEventInput {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.offenderIp !== 'string' || !v.offenderIp.trim()) return false
  if (v.types !== undefined && !Array.isArray(v.types)) return false
  const action = v.action
  if (action !== undefined && !['alert', 'throttle', 'freeze', 'recover'].includes(String(action))) return false
  return true
}

export default async function abuseRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Agent 上报风控事件（批量）。
   */
  fastify.post<{ Body: { events?: unknown[] } }>('/api/agent/abuse-event', async (request, reply) => {
    const agent = await authenticateAgent(request, reply)
    if (!agent) return

    const events = Array.isArray(request.body?.events) ? request.body.events : []
    if (events.length === 0) {
      return reply.send({ received: 0, commands: [] })
    }
    if (events.length > 100) {
      return reply.code(400).send({ error: 'Too many events in one batch (max 100)', code: 'ABUSE_BATCH_TOO_LARGE' })
    }

    let received = 0
    for (const raw of events) {
      if (!isValidAbuseEvent(raw)) continue
      try {
        await recordAbuseEvent(agent.hostId, raw)
        received++
      } catch (error) {
        request.log.error({ err: error }, 'recordAbuseEvent failed')
      }
    }

    // commands 预留给未来的 panel->agent 下发指令（如解封），当前恒为空。
    // TODO(commands): 心跳响应中增加 pending commands 队列，以下发解封/限速指令。
    return reply.send({ received, commands: [] })
  })

  /**
   * 管理员分页查询风控事件。
   */
  fastify.get<{
    Querystring: { page?: string; pageSize?: string; instanceId?: string; type?: string }
  }>('/api/admin/abuse-events', {
    onRequest: [fastify.authenticateAdmin]
  }, async (request) => {
    const q = request.query
    const page = q.page ? parseInt(q.page, 10) : 1
    const pageSize = q.pageSize ? parseInt(q.pageSize, 10) : 20
    const instanceId = q.instanceId ? parseInt(q.instanceId, 10) : undefined
    return listAbuseEvents({
      page: Number.isSafeInteger(page) ? page : 1,
      pageSize: Number.isSafeInteger(pageSize) ? pageSize : 20,
      instanceId: instanceId !== undefined && Number.isSafeInteger(instanceId) ? instanceId : undefined,
      type: q.type || undefined
    })
  })

  /**
   * 管理员确认风控事件（审计留痕）。
   */
  fastify.post<{
    Params: { id: string }
    Body: { note?: string }
  }>('/api/admin/abuse-events/:id/ack', {
    onRequest: [fastify.authenticateAdmin]
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10)
    if (!Number.isSafeInteger(id)) {
      return reply.code(400).send({ error: 'Invalid event id', code: 'ABUSE_INVALID_ID' })
    }
    const event = await getAbuseEvent(id)
    if (!event) {
      return reply.code(404).send({ error: 'Abuse event not found', code: 'ABUSE_NOT_FOUND' })
    }
    const note = typeof request.body?.note === 'string' ? request.body.note.slice(0, 500) : ''
    await recordAbuseAdminOp(request.user.id, id, 'ack', note)
    return reply.send({ ok: true })
  })

  /**
   * 管理员请求解封。
   *
   * 当前实现：仅记录解封请求日志（pending 状态）。
   * TODO(commands): agent 侧目前只有心跳上报通道，panel->agent 尚无通用指令通道。
   *   待实现心跳响应的 pending commands 队列后，此处改为入队解封指令，
   *   agent 在下次上报/心跳时拉取并执行 Unblock。
   *   在此之前，解封需管理员登录宿主机手动执行：
   *   iptables -D FORWARD -s <ip> -m comment --comment "NOVAINCUS_ABUSE:block:<ip>" -j DROP
   */
  fastify.post<{
    Params: { id: string }
    Body: { note?: string }
  }>('/api/admin/abuse-events/:id/unblock', {
    onRequest: [fastify.authenticateAdmin]
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10)
    if (!Number.isSafeInteger(id)) {
      return reply.code(400).send({ error: 'Invalid event id', code: 'ABUSE_INVALID_ID' })
    }
    const event = await getAbuseEvent(id)
    if (!event) {
      return reply.code(404).send({ error: 'Abuse event not found', code: 'ABUSE_NOT_FOUND' })
    }
    const note = typeof request.body?.note === 'string' ? request.body.note.slice(0, 500) : ''
    await recordAbuseAdminOp(request.user.id, id, 'unblock_requested', note)
    return reply.send({
      ok: true,
      status: 'pending',
      offenderIp: event.offenderIp,
      message: '解封请求已记录，待 agent 指令通道实现后自动下发；当前需手动在宿主机执行 iptables 解封（见代码注释）'
    })
  })
}
