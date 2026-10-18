/**
 * 防滥用风控事件数据库操作（Phase 3）
 *
 * 设计说明：
 * - 复用现有 Log 表（module='security'，action='abuse.*'），不新增表结构，
 *   因此无需 Prisma 迁移。
 * - content 采用「人类可读摘要 + 机器可读 ip= 标记」的格式，供解封路由解析。
 */

import type { Log } from '@prisma/client'
import { prisma } from './prisma.js'
import { createLog, getLogsPaginated, LogResult } from './logs.js'

// ==================== 类型定义 ====================

export type AbuseEventInput = {
  occurredAt?: string
  offenderIp: string
  instanceName?: string
  types: string[]
  severity: 'warning' | 'high' | 'critical' | 'info'
  action: 'alert' | 'throttle' | 'freeze' | 'recover'
  detail?: string
}

export type AbuseEventRecord = {
  id: number
  offenderIp: string | null
  instanceId: number | null
  instanceName: string | null
  username: string | null
  action: string
  severity: string
  content: string
  result: string
  createdAt: string
}

// ==================== 写入 ====================

/**
 * 记录一条 agent 上报的风控事件。
 * 尝试按实例名 + 宿主机把事件关联到 instanceId，便于在实例维度检索。
 */
export async function recordAbuseEvent(
  hostId: number,
  input: AbuseEventInput
): Promise<void> {
  const offenderIp = String(input.offenderIp || '').trim()
  if (!offenderIp) return

  const types = Array.isArray(input.types) && input.types.length > 0 ? input.types : ['unknown']
  const action = input.action || 'alert'
  const instanceName = String(input.instanceName || '').trim()

  let instanceId: number | null = null
  if (instanceName && instanceName !== 'host' && instanceName !== 'unknown') {
    try {
      const instance = await prisma.instance.findFirst({
        where: { name: instanceName, hostId },
        select: { id: true }
      })
      instanceId = instance?.id ?? null
    } catch {
      instanceId = null
    }
  }

  const occurred = input.occurredAt ? ` @${input.occurredAt}` : ''
  const summary = instanceName
    ? `实例 "${instanceName}" (${offenderIp})`
    : offenderIp
  const content =
    `[风控${occurred}] ${summary} 触发 [${types.join(',')}]，处置动作: ${action}` +
    (input.detail ? `，${input.detail}` : '') +
    ` | ip=${offenderIp}`

  const result =
    input.severity === 'critical' ? LogResult.FAILED
    : input.severity === 'info' ? LogResult.SUCCESS
    : LogResult.WARNING

  await createLog(null, 'security', `abuse.${types[0]}`, content, result, { instanceId })
}

/**
 * 记录管理员对风控事件的确认 / 解封请求（审计留痕）。
 */
export async function recordAbuseAdminOp(
  adminUserId: number,
  eventId: number,
  op: 'ack' | 'unblock_requested',
  note: string
): Promise<void> {
  const action = op === 'ack' ? 'abuse.ack' : 'abuse.unblock_requested'
  await createLog(
    adminUserId,
    'security',
    action,
    `[风控] 管理员对事件 #${eventId} 执行 ${op === 'ack' ? '确认' : '解封请求'}${note ? `：${note}` : ''} | eventId=${eventId}`,
    LogResult.SUCCESS
  )
}

// ==================== 查询 ====================

/**
 * 从 content 中解析机器可读的 offender IP（recordAbuseEvent 写入的 ip= 标记）。
 */
export function parseOffenderIp(content: string): string | null {
  const match = /ip=([0-9a-fA-F:.]+)/.exec(content || '')
  return match ? match[1] : null
}

function toRecord(log: Log): AbuseEventRecord {
  const nameMatch = /实例 "([^"]+)"/.exec(log.content || '')
  return {
    id: log.id,
    offenderIp: parseOffenderIp(log.content),
    instanceId: log.instanceId,
    instanceName: nameMatch ? nameMatch[1] : null,
    username: null,
    action: log.action,
    severity: log.result === 'failed' ? 'critical' : log.result === 'success' ? 'info' : 'warning',
    content: log.content,
    result: log.result,
    createdAt: log.createdAt.toISOString()
  }
}

/**
 * 分页查询风控事件（action 以 abuse. 开头的安全日志）。
 */
export async function listAbuseEvents(options: {
  page?: number
  pageSize?: number
  instanceId?: number
  type?: string
} = {}): Promise<{
  items: AbuseEventRecord[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}> {
  const { page = 1, pageSize = 20, instanceId, type } = options

  const result = await getLogsPaginated({
    page,
    pageSize,
    module: 'security',
    search: 'abuse.',
    instanceId
  })

  let items = result.items.filter(log => log.action.startsWith('abuse.'))
  if (type) {
    items = items.filter(log => log.action === `abuse.${type}`)
  }

  return {
    items: items.map(toRecord),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages
  }
}

/**
 * 按 id 取单条风控事件。
 */
export async function getAbuseEvent(id: number): Promise<AbuseEventRecord | null> {
  const log = await prisma.log.findUnique({ where: { id } })
  if (!log || log.module !== 'security' || !log.action.startsWith('abuse.')) {
    return null
  }
  return toRecord(log)
}
