/**
 * Telegram 专用机器人路由
 * 负责账号绑定、Webhook 管理和私有群入群申请。
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import * as db from '../db/index.js'
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { formatBytes } from '../services/traffic-utils.js'

interface TelegramWebhookUser {
  id: number
  username?: string
  first_name?: string
  last_name?: string
}

interface TelegramWebhookUpdate {
  message?: {
    chat?: {
      id: number
      type?: string
    }
    from?: TelegramWebhookUser
    text?: string
  }
}

interface TelegramBotConfig {
  enabled: boolean
  configured: boolean
  botUsername: string | null
  botToken: string | null
  webhookSecret: string | null
  group: TelegramGroupConfig
  vipGroup: TelegramGroupConfig
}

type TelegramGroupJoinMode = 'any' | 'all'
type TelegramGroupJoinTarget = 'normal' | 'vip'

interface TelegramGroupConfig {
  enabled: boolean
  configured: boolean
  chatId: string | null
  joinMode: TelegramGroupJoinMode
  minRecharge: number
  minConsume: number
  inviteExpireMinutes: number
}

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

interface TelegramWebhookInfo {
  url: string
  has_custom_certificate?: boolean
  pending_update_count?: number
  last_error_date?: number
  last_error_message?: string
  max_connections?: number
  allowed_updates?: string[]
}

interface TelegramAdminBindingsQuery {
  page?: string
  pageSize?: string
  search?: string
}

interface TelegramAdminBindingParams {
  id: string
}

interface TelegramInviteLinkResult {
  invite_link: string
}

interface TelegramChatMember {
  status: string
}

interface TelegramBotCommand {
  command: string
  description: string
}

const bindTokenPrefix = 'bind_'
const bindTokenTtlMs = 10 * 60 * 1000
const telegramWebhookSecretPattern = /^[A-Za-z0-9_-]{1,256}$/
const telegramBotCommands: TelegramBotCommand[] = [
  { command: 'start', description: '绑定站内账号 / 查看使用说明（/start 实例名 可开机）' },
  { command: 'instances', description: '查看我的实例列表' },
  { command: 'stop', description: '关机实例（/stop 实例名）' },
  { command: 'traffic', description: '查询实例本月流量（/traffic 实例名）' },
  { command: 'balance', description: '查询账户余额' },
  { command: 'join', description: '申请加入普通用户群' },
  { command: 'join_vip', description: '申请加入高级用户群' }
]
// 需要站内账号绑定的交互命令（/start 不带参数时除外，走原有帮助文案）
const telegramInteractiveCommands = new Set(['/instances', '/start', '/stop', '/traffic', '/balance'])
const telegramGroupCommandAliases = ['join', 'group', 'apply_group']
const telegramGroupCommands = new Set(telegramGroupCommandAliases.map(command => `/${command}`))
const telegramVipGroupCommands = new Set(['/join_vip'])

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function secureEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  if (aBuffer.length !== bBuffer.length) {
    return false
  }
  return timingSafeEqual(aBuffer, bBuffer)
}

function normalizeBotUsername(value: string | null): string | null {
  const username = value?.trim().replace(/^@/, '')
  return username || null
}

function isValidTelegramWebhookSecret(value: string): boolean {
  return telegramWebhookSecretPattern.test(value)
}

function parseNonNegativeAmount(value: string | null, fallback = 0): number {
  const amount = Number.parseFloat(value || '')
  if (!Number.isFinite(amount) || amount < 0) {
    return fallback
  }
  return Math.round(amount * 100) / 100
}

function parseInviteExpireMinutes(value: string | null): number {
  const minutes = Number.parseInt(value || '', 10)
  if (!Number.isFinite(minutes)) {
    return 30
  }
  return Math.min(Math.max(minutes, 1), 10080)
}

function normalizeGroupJoinMode(value: string | null): TelegramGroupJoinMode {
  return value === 'all' ? 'all' : 'any'
}

function buildTelegramGroupConfig(
  enabled: boolean,
  chatIdValue: string | null,
  joinModeValue: string | null,
  minRechargeValue: string | null,
  minConsumeValue: string | null,
  inviteExpireMinutesValue: string | null
): TelegramGroupConfig {
  const chatId = chatIdValue?.trim() || null
  return {
    enabled,
    configured: Boolean(enabled && chatId),
    chatId,
    joinMode: normalizeGroupJoinMode(joinModeValue),
    minRecharge: parseNonNegativeAmount(minRechargeValue),
    minConsume: parseNonNegativeAmount(minConsumeValue),
    inviteExpireMinutes: parseInviteExpireMinutes(inviteExpireMinutesValue)
  }
}

async function getTelegramBotConfig(): Promise<TelegramBotConfig> {
  const [
    enabled,
    botUsernameValue,
    botToken,
    webhookSecret,
    groupEnabled,
    groupChatIdValue,
    groupJoinModeValue,
    groupMinRechargeValue,
    groupMinConsumeValue,
    groupInviteExpireMinutesValue,
    vipGroupEnabled,
    vipGroupChatIdValue,
    vipGroupJoinModeValue,
    vipGroupMinRechargeValue,
    vipGroupMinConsumeValue,
    vipGroupInviteExpireMinutesValue
  ] = await Promise.all([
    db.getSystemConfigBoolean('telegram_bot_enabled', false),
    db.getSystemConfig('telegram_bot_username'),
    db.getSystemConfig('telegram_bot_token'),
    db.getSystemConfig('telegram_webhook_secret'),
    db.getSystemConfigBoolean('telegram_group_join_enabled', false),
    db.getSystemConfig('telegram_group_chat_id'),
    db.getSystemConfig('telegram_group_join_mode'),
    db.getSystemConfig('telegram_group_min_recharge'),
    db.getSystemConfig('telegram_group_min_consume'),
    db.getSystemConfig('telegram_group_invite_expire_minutes'),
    db.getSystemConfigBoolean('telegram_vip_group_join_enabled', false),
    db.getSystemConfig('telegram_vip_group_chat_id'),
    db.getSystemConfig('telegram_vip_group_join_mode'),
    db.getSystemConfig('telegram_vip_group_min_recharge'),
    db.getSystemConfig('telegram_vip_group_min_consume'),
    db.getSystemConfig('telegram_vip_group_invite_expire_minutes')
  ])
  const botUsername = normalizeBotUsername(botUsernameValue)
  const webhookSecretValue = webhookSecret?.trim() || null
  const group = buildTelegramGroupConfig(
    groupEnabled,
    groupChatIdValue,
    groupJoinModeValue,
    groupMinRechargeValue,
    groupMinConsumeValue,
    groupInviteExpireMinutesValue
  )
  const vipGroup = buildTelegramGroupConfig(
    vipGroupEnabled,
    vipGroupChatIdValue,
    vipGroupJoinModeValue,
    vipGroupMinRechargeValue,
    vipGroupMinConsumeValue,
    vipGroupInviteExpireMinutesValue
  )

  return {
    enabled,
    configured: Boolean(enabled && botUsername && botToken && webhookSecretValue && isValidTelegramWebhookSecret(webhookSecretValue)),
    botUsername,
    botToken,
    webhookSecret: webhookSecretValue,
    group,
    vipGroup
  }
}

async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<boolean> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  })

  return response.ok
}

async function callTelegramApi<T>(
  botToken: string,
  method: string,
  payload?: Record<string, unknown>
): Promise<TelegramApiResponse<T>> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined
  })
  const data = await response.json().catch(() => null)

  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      description: `Telegram API returned HTTP ${response.status}`,
      error_code: response.status
    }
  }

  return data as TelegramApiResponse<T>
}

async function syncTelegramBotCommands(botToken: string): Promise<TelegramApiResponse<boolean>> {
  return callTelegramApi<boolean>(botToken, 'setMyCommands', {
    commands: telegramBotCommands
  })
}

function normalizeWebhookBaseUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null
    }
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] || null
  }
  return value || null
}

function buildWebhookUrl(request: FastifyRequest, baseUrl?: string): string | null {
  const explicitBaseUrl = baseUrl ? normalizeWebhookBaseUrl(baseUrl) : null
  if (explicitBaseUrl) {
    return `${explicitBaseUrl}/api/telegram/webhook`
  }

  const configuredBaseUrl = (process.env.SITE_URL || process.env.FRONTEND_URL?.split(',')[0])?.trim()
  if (configuredBaseUrl) {
    const normalized = normalizeWebhookBaseUrl(configuredBaseUrl)
    if (normalized) {
      return `${normalized}/api/telegram/webhook`
    }
  }

  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto'])
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host'])
  const host = forwardedHost || firstHeaderValue(request.headers.host) || request.hostname
  const proto = forwardedProto || request.protocol
  const normalized = normalizeWebhookBaseUrl(`${proto}://${host}`)
  return normalized ? `${normalized}/api/telegram/webhook` : null
}

function normalizeTelegramCommand(text: string): string {
  return text.trim().split(/\s+/)[0].replace(/@\w+$/, '').toLowerCase()
}

function getGroupJoinTarget(text: string): TelegramGroupJoinTarget | null {
  const normalized = text.trim().toLowerCase()
  if (/^\/start\s+(join|group|apply_group)$/.test(normalized)) {
    return 'normal'
  }
  if (/^\/start\s+join_vip$/.test(normalized)) {
    return 'vip'
  }
  const command = normalizeTelegramCommand(text)
  if (telegramGroupCommands.has(command)) {
    return 'normal'
  }
  if (telegramVipGroupCommands.has(command)) {
    return 'vip'
  }
  return null
}

function formatMoney(value: number): string {
  return value.toFixed(2)
}

function parsePositiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback
  }
  return Math.min(parsed, max)
}

function evaluateGroupEligibility(
  stats: { totalRecharge: number; totalConsume: number },
  group: TelegramGroupConfig
): { eligible: boolean; message: string } {
  const rechargeRequired = group.minRecharge > 0
  const consumeRequired = group.minConsume > 0

  if (!rechargeRequired && !consumeRequired) {
    return {
      eligible: true,
      message: '当前未设置金额门槛。'
    }
  }

  const rechargePassed = !rechargeRequired || stats.totalRecharge >= group.minRecharge
  const consumePassed = !consumeRequired || stats.totalConsume >= group.minConsume
  const eligible = group.joinMode === 'all'
    ? rechargePassed && consumePassed
    : (rechargeRequired && rechargePassed) || (consumeRequired && consumePassed)
  const requirements = [
    rechargeRequired ? `累计充值 ¥${formatMoney(group.minRecharge)}（当前 ¥${formatMoney(stats.totalRecharge)}）` : null,
    consumeRequired ? `累计消费 ¥${formatMoney(group.minConsume)}（当前 ¥${formatMoney(stats.totalConsume)}）` : null
  ].filter(Boolean)

  return {
    eligible,
    message: `${group.joinMode === 'all' ? '需同时满足' : '满足任一即可'}：${requirements.join('；')}`
  }
}

function buildAdminGroupEligibility(
  stats: { totalRecharge: number; totalConsume: number },
  group: TelegramGroupConfig,
  groupName = '私有群'
): {
  eligible: boolean
  status: 'eligible' | 'ineligible' | 'disabled' | 'unconfigured'
  message: string
  joinMode: TelegramGroupJoinMode
  minRecharge: number
  minConsume: number
} {
  if (!group.enabled) {
    return {
      eligible: false,
      status: 'disabled',
      message: `${groupName}入群申请未启用。`,
      joinMode: group.joinMode,
      minRecharge: group.minRecharge,
      minConsume: group.minConsume
    }
  }

  if (!group.configured) {
    return {
      eligible: false,
      status: 'unconfigured',
      message: `${groupName} Chat ID 未配置。`,
      joinMode: group.joinMode,
      minRecharge: group.minRecharge,
      minConsume: group.minConsume
    }
  }

  const eligibility = evaluateGroupEligibility(stats, group)
  return {
    eligible: eligibility.eligible,
    status: eligibility.eligible ? 'eligible' : 'ineligible',
    message: eligibility.message,
    joinMode: group.joinMode,
    minRecharge: group.minRecharge,
    minConsume: group.minConsume
  }
}

export default async function telegramRoutes(fastify: FastifyInstance) {
  const telegramBindingModel = (prisma as any).userTelegramBinding
  const telegramBindTokenModel = (prisma as any).telegramBindToken

  async function notifyTelegram(botToken: string, chatId: number, text: string): Promise<void> {
    try {
      const sent = await sendTelegramMessage(botToken, chatId, text)
      if (!sent) {
        fastify.log.warn({ chatId }, 'Telegram message API returned non-OK response')
      }
    } catch (error) {
      fastify.log.warn({ err: error, chatId }, 'Failed to send Telegram message')
    }
  }

  function serializeGroupConfig(group: TelegramGroupConfig) {
    return {
      enabled: group.enabled,
      configured: group.configured,
      joinMode: group.joinMode,
      minRecharge: group.minRecharge,
      minConsume: group.minConsume
    }
  }

  async function buildAdminBindingView(binding: any, group: TelegramGroupConfig, vipGroup: TelegramGroupConfig) {
    const stats = await db.getUserConsumeStats(binding.userId)
    const eligibility = buildAdminGroupEligibility(stats, group, '普通群')
    const vipEligibility = buildAdminGroupEligibility(stats, vipGroup, '高级群')

    return {
      id: binding.id,
      userId: binding.userId,
      user: binding.user ? {
        id: binding.user.id,
        username: binding.user.username,
        email: binding.user.email,
        status: binding.user.status
      } : null,
      telegramUserId: binding.telegramUserId,
      telegramUsername: binding.telegramUsername,
      firstName: binding.firstName,
      lastName: binding.lastName,
      boundAt: binding.boundAt.toISOString(),
      updatedAt: binding.updatedAt.toISOString(),
      stats: {
        totalRecharge: stats.totalRecharge,
        totalConsume: stats.totalConsume,
        totalRefund: stats.totalRefund,
        totalDestroyedValue: stats.totalDestroyedValue
      },
      eligibility,
      vipEligibility
    }
  }

  async function isTelegramUserInGroup(
    botToken: string,
    groupChatId: string,
    telegramUserId: number
  ): Promise<boolean | null> {
    const response = await callTelegramApi<TelegramChatMember>(botToken, 'getChatMember', {
      chat_id: groupChatId,
      user_id: telegramUserId
    })

    if (!response.ok || !response.result) {
      return null
    }

    return !['left', 'kicked'].includes(response.result.status)
  }

  async function createGroupInviteLink(
    botToken: string,
    group: TelegramGroupConfig,
    inviteName: string
  ): Promise<{ inviteLink?: string; error?: string; errorCode?: number }> {
    if (!group.chatId) {
      return { error: 'Telegram group chat ID is not configured' }
    }

    const expireDate = Math.floor(Date.now() / 1000) + group.inviteExpireMinutes * 60
    const response = await callTelegramApi<TelegramInviteLinkResult>(botToken, 'createChatInviteLink', {
      chat_id: group.chatId,
      expire_date: expireDate,
      member_limit: 1,
      name: inviteName
    })

    if (!response.ok || !response.result?.invite_link) {
      return {
        error: response.description || 'Telegram invite link creation failed',
        errorCode: response.error_code
      }
    }

    return { inviteLink: response.result.invite_link }
  }

  async function handleGroupJoinRequest(
    config: TelegramBotConfig,
    chatId: number,
    from: TelegramWebhookUser,
    chatType: string | undefined,
    target: TelegramGroupJoinTarget
  ): Promise<void> {
    if (!config.botToken) {
      return
    }

    const group = target === 'vip' ? config.vipGroup : config.group
    const groupName = target === 'vip' ? '高级用户群' : '普通用户群'
    const command = target === 'vip' ? '/join_vip' : '/join'
    const inviteName = target === 'vip' ? 'Incudal VIP access' : 'Incudal user access'

    if (chatType && chatType !== 'private') {
      await notifyTelegram(config.botToken, chatId, `请私聊机器人发送 ${command} 申请${groupName}，避免邀请链接泄露到群聊。`)
      return
    }

    if (!group.enabled || !group.configured) {
      await notifyTelegram(config.botToken, chatId, `${groupName}申请暂未开放，请稍后再试或联系管理员。`)
      return
    }

    const telegramUserId = String(from.id)
    const binding = await telegramBindingModel.findUnique({
      where: { telegramUserId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            status: true
          }
        }
      }
    })

    if (!binding?.user) {
      await notifyTelegram(config.botToken, chatId, `请先登录网站，在个人设置里完成 Telegram 绑定后再发送 ${command}。`)
      return
    }

    if (binding.user.status !== 'active') {
      await notifyTelegram(config.botToken, chatId, '你的站内账号当前不可用，暂不能申请入群。')
      return
    }

    const stats = await db.getUserConsumeStats(binding.user.id)
    const eligibility = evaluateGroupEligibility(stats, group)
    if (!eligibility.eligible) {
      await notifyTelegram(
        config.botToken,
        chatId,
        `暂未达到${groupName}入群条件。\n${eligibility.message}`
      )
      return
    }

    if (group.chatId) {
      const alreadyInGroup = await isTelegramUserInGroup(config.botToken, group.chatId, from.id)
      if (alreadyInGroup) {
        await notifyTelegram(config.botToken, chatId, `你已经在${groupName}内，无需重复申请。`)
        return
      }
    }

    const inviteResult = await createGroupInviteLink(config.botToken, group, inviteName)
    if (!inviteResult.inviteLink) {
      fastify.log.warn(
        { err: inviteResult.error, errorCode: inviteResult.errorCode },
        'Telegram group invite link creation failed'
      )
      await notifyTelegram(config.botToken, chatId, '生成邀请链接失败，请联系管理员检查机器人群管理员权限。')
      return
    }

    await notifyTelegram(
      config.botToken,
      chatId,
      `已达标，可以加入${groupName}。\n${eligibility.message}\n\n一次性邀请链接：${inviteResult.inviteLink}\n有效期：${group.inviteExpireMinutes} 分钟。`
    )
  }

  function formatInstanceStatus(status: string): string {
    const labels: Record<string, string> = {
      running: '运行中',
      stopped: '已关机',
      suspended: '已封停',
      creating: '创建中',
      starting: '开机中',
      stopping: '关机中',
      restarting: '重启中',
      rebuilding: '重装中',
      migrating: '迁移中',
      error: '异常'
    }
    return labels[status] || status
  }

  async function getBoundUserId(telegramUserId: string): Promise<number | null> {
    const binding = await telegramBindingModel.findUnique({
      where: { telegramUserId }
    })
    return binding ? binding.userId : null
  }

  async function resolveUserInstanceByName(
    userId: number,
    nameArg: string
  ): Promise<{ instance?: any; error?: string }> {
    const needle = nameArg.trim().toLowerCase()
    if (!needle) {
      return { error: '请指定实例名，例如：/start 我的小鸡' }
    }
    const instances = await db.getInstancesByUserId(userId)
    const matched = instances.filter((item) => item.name.toLowerCase() === needle)
    if (matched.length === 0) {
      return { error: `找不到名为「${nameArg.trim()}」的实例，发送 /instances 查看你的实例列表。` }
    }
    if (matched.length > 1) {
      return { error: `有多个实例都叫「${nameArg.trim()}」，请先在网站上重命名后再操作。` }
    }
    return { instance: matched[0] }
  }

  /**
   * 处理需要站内账号绑定的交互命令。
   * 返回 true 表示命令已被消费（无论成功失败），false 表示不是交互命令。
   * 鉴权：只允许操作命令发送者自己绑定的站内账号名下的实例。
   */
  async function handleInteractiveCommand(
    config: TelegramBotConfig,
    chatId: number,
    chatType: string | undefined,
    from: TelegramWebhookUser,
    text: string
  ): Promise<boolean> {
    const command = normalizeTelegramCommand(text)
    if (!telegramInteractiveCommands.has(command)) {
      return false
    }

    const botToken = config.botToken
    if (!botToken) {
      return true
    }

    // /start 不带参数时保持原有行为：走兜底帮助文案
    const parts = text.trim().split(/\s+/)
    if (command === '/start' && parts.length === 1) {
      return false
    }

    // 实例管理指令仅允许私聊，避免实例信息泄露到群聊
    if (chatType && chatType !== 'private') {
      await notifyTelegram(botToken, chatId, '实例管理指令请私聊机器人使用，避免信息泄露到群聊。')
      return true
    }

    const userId = await getBoundUserId(String(from.id))
    if (!userId) {
      await notifyTelegram(
        botToken,
        chatId,
        '请先绑定站内账号：登录网站 → 个人设置 → 生成 Telegram 绑定链接，在有效期内发送给我。'
      )
      return true
    }

    if (command === '/balance') {
      const balance = await db.getUserBalance(userId)
      await notifyTelegram(botToken, chatId, `当前账户余额：¥${formatMoney(balance)}`)
      return true
    }

    if (command === '/instances') {
      const instances = await db.getInstancesByUserId(userId)
      if (instances.length === 0) {
        await notifyTelegram(botToken, chatId, '你还没有实例，去网站上开一台吧。')
        return true
      }
      const lines = instances.map((item) => {
        const ip = item.ipv4 ? `（${item.ipv4}）` : ''
        return `• ${item.name} — ${formatInstanceStatus(item.status)}${ip}`
      })
      await notifyTelegram(botToken, chatId, `你的实例（${instances.length} 台）：\n${lines.join('\n')}`)
      return true
    }

    const arg = parts.slice(1).join(' ')
    const { instance, error } = await resolveUserInstanceByName(userId, arg)
    if (error || !instance) {
      await notifyTelegram(botToken, chatId, error || '实例不存在。')
      return true
    }

    if (command === '/traffic') {
      const record = await prisma.instance.findUnique({
        where: { id: instance.id },
        select: { monthlyTrafficUsed: true, monthlyTrafficLimit: true }
      })
      const used = record ? formatBytes(record.monthlyTrafficUsed) : '未知'
      const limit = record?.monthlyTrafficLimit ? formatBytes(record.monthlyTrafficLimit) : '无限制'
      await notifyTelegram(
        botToken,
        chatId,
        `实例「${instance.name}」本月流量：\n已用 ${used}\n总量 ${limit}`
      )
      return true
    }

    if (command === '/start' || command === '/stop') {
      const action = command === '/start' ? 'start' : 'stop'
      const actionText = command === '/start' ? '开机' : '关机'

      if (command === '/start' && instance.status === 'running') {
        await notifyTelegram(botToken, chatId, `实例「${instance.name}」已在运行中。`)
        return true
      }
      if (command === '/stop' && instance.status === 'stopped') {
        await notifyTelegram(botToken, chatId, `实例「${instance.name}」已经是关机状态。`)
        return true
      }
      if (instance.status === 'suspended') {
        await notifyTelegram(botToken, chatId, `实例「${instance.name}」已被封停，无法${actionText}，请联系管理员。`)
        return true
      }

      const activeTask = await db.getActiveTaskForInstance(instance.id)
      if (activeTask) {
        await notifyTelegram(
          botToken,
          chatId,
          `实例「${instance.name}」有进行中的任务（${activeTask.taskType}），请稍后再试。`
        )
        return true
      }

      const task = await db.createInstanceTask({
        instanceId: instance.id,
        hostId: instance.host_id,
        userId,
        taskType: action
      })

      await createLog(
        userId,
        'instance',
        `instance.${action}`,
        `Telegram bot queued ${action} task for instance "${instance.name}"`,
        'success',
        { instanceId: instance.id }
      )

      await notifyTelegram(
        botToken,
        chatId,
        `已提交${actionText}任务「${instance.name}」（任务 #${task.id}），稍后发送 /instances 查看状态。`
      )
      return true
    }

    return false
  }

  fastify.get('/admin/webhook/info', {
    onRequest: [fastify.authenticateAdmin]
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const config = await getTelegramBotConfig()
    if (!config.botToken) {
      return reply.code(400).send({ error: 'Telegram bot token is not configured' })
    }

    const telegramResponse = await callTelegramApi<TelegramWebhookInfo>(config.botToken, 'getWebhookInfo')
    if (!telegramResponse.ok) {
      return reply.code(502).send({
        error: telegramResponse.description || 'Telegram webhook info request failed',
        errorCode: telegramResponse.error_code
      })
    }

    return {
      info: telegramResponse.result
    }
  })

  fastify.post<{ Body: { baseUrl?: string } }>('/admin/webhook/setup', {
    onRequest: [fastify.authenticateAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string', minLength: 1 }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: { baseUrl?: string } }>, reply: FastifyReply) => {
    const config = await getTelegramBotConfig()
    if (!config.botToken) {
      return reply.code(400).send({ error: 'Telegram bot token is not configured' })
    }
    if (!config.webhookSecret) {
      return reply.code(400).send({ error: 'Telegram webhook secret is not configured' })
    }
    if (!isValidTelegramWebhookSecret(config.webhookSecret)) {
      return reply.code(400).send({
        error: 'Telegram webhook secret can only contain letters, numbers, underscores, and hyphens',
        code: 'TELEGRAM_WEBHOOK_SECRET_INVALID'
      })
    }

    const webhookUrl = buildWebhookUrl(request, request.body?.baseUrl)
    if (!webhookUrl) {
      return reply.code(400).send({ error: 'Unable to build Telegram webhook URL' })
    }

    const telegramResponse = await callTelegramApi<boolean>(config.botToken, 'setWebhook', {
      url: webhookUrl,
      secret_token: config.webhookSecret,
      allowed_updates: ['message']
    })
    if (!telegramResponse.ok) {
      return reply.code(502).send({
        error: telegramResponse.description || 'Telegram webhook setup failed',
        errorCode: telegramResponse.error_code,
        webhookUrl
      })
    }

    const commandsResponse = await syncTelegramBotCommands(config.botToken)
    if (!commandsResponse.ok) {
      return reply.code(502).send({
        error: commandsResponse.description || 'Telegram bot command setup failed',
        errorCode: commandsResponse.error_code,
        webhookUrl,
        webhookConfigured: true
      })
    }

    return {
      message: 'Telegram webhook configured',
      webhookUrl,
      commandsSynced: true,
      commands: telegramBotCommands,
      result: telegramResponse.result
    }
  })

  fastify.post('/admin/webhook/delete', {
    onRequest: [fastify.authenticateAdmin]
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const config = await getTelegramBotConfig()
    if (!config.botToken) {
      return reply.code(400).send({ error: 'Telegram bot token is not configured' })
    }

    const telegramResponse = await callTelegramApi<boolean>(config.botToken, 'deleteWebhook')
    if (!telegramResponse.ok) {
      return reply.code(502).send({
        error: telegramResponse.description || 'Telegram webhook delete failed',
        errorCode: telegramResponse.error_code
      })
    }

    return {
      message: 'Telegram webhook deleted',
      result: telegramResponse.result
    }
  })

  fastify.get<{ Querystring: TelegramAdminBindingsQuery }>('/admin/bindings', {
    onRequest: [fastify.authenticateAdmin]
  }, async (request: FastifyRequest<{ Querystring: TelegramAdminBindingsQuery }>) => {
    const page = parsePositiveInteger(request.query.page, 1, 100000)
    const pageSize = parsePositiveInteger(request.query.pageSize, 5, 100)
    const search = request.query.search?.trim()
    const config = await getTelegramBotConfig()
    const where: any = {}

    if (search) {
      const or: any[] = [
        { telegramUserId: { contains: search } },
        { telegramUsername: { contains: search } },
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { user: { username: { contains: search } } },
        { user: { email: { contains: search } } }
      ]

      if (/^\d+$/.test(search)) {
        const numericSearch = Number(search)
        if (Number.isSafeInteger(numericSearch)) {
          or.push({ id: numericSearch }, { userId: numericSearch })
        }
      }

      where.OR = or
    }

    const [bindings, total] = await Promise.all([
      telegramBindingModel.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              email: true,
              status: true
            }
          }
        },
        orderBy: { boundAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      telegramBindingModel.count({ where })
    ])

    return {
      bindings: await Promise.all(bindings.map((binding: any) => buildAdminBindingView(binding, config.group, config.vipGroup))),
      total,
      page,
      pageSize,
      group: serializeGroupConfig(config.group),
      vipGroup: serializeGroupConfig(config.vipGroup)
    }
  })

  fastify.delete<{ Params: TelegramAdminBindingParams }>('/admin/bindings/:id', {
    onRequest: [fastify.authenticateAdmin]
  }, async (request: FastifyRequest<{ Params: TelegramAdminBindingParams }>, reply: FastifyReply) => {
    const bindingId = Number.parseInt(request.params.id, 10)
    if (!Number.isSafeInteger(bindingId) || bindingId < 1) {
      return reply.code(400).send({ error: 'Invalid Telegram binding ID' })
    }

    const binding = await telegramBindingModel.findUnique({
      where: { id: bindingId },
      include: {
        user: {
          select: {
            id: true,
            username: true
          }
        }
      }
    })

    if (!binding) {
      return reply.code(404).send({ error: 'Telegram binding not found' })
    }

    await telegramBindingModel.delete({
      where: { id: bindingId }
    })

    await createLog(
      request.user.id,
      'system',
      'telegram.binding_unlink',
      `Admin unlinked Telegram binding for user #${binding.userId} (${binding.user?.username || 'unknown'})`,
      'success'
    )

    return { message: 'Telegram binding removed' }
  })

  fastify.get('/binding', {
    onRequest: [fastify.authenticate]
  }, async (request: FastifyRequest) => {
    const config = await getTelegramBotConfig()
    const binding = await telegramBindingModel.findUnique({
      where: { userId: request.user.id }
    })

    return {
      enabled: config.enabled,
      configured: config.configured,
      botUsername: config.botUsername,
      binding: binding ? {
        telegramUserId: binding.telegramUserId,
        telegramUsername: binding.telegramUsername,
        firstName: binding.firstName,
        lastName: binding.lastName,
        boundAt: binding.boundAt.toISOString()
      } : null
    }
  })

  fastify.post('/bind-token', {
    onRequest: [fastify.authenticate]
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const config = await getTelegramBotConfig()
    if (!config.configured || !config.botUsername) {
      return reply.code(400).send({ error: 'Telegram bot is not configured' })
    }

    await telegramBindTokenModel.deleteMany({
      where: {
        userId: request.user.id,
        usedAt: null
      }
    })

    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + bindTokenTtlMs)

    await telegramBindTokenModel.create({
      data: {
        userId: request.user.id,
        tokenHash: hashToken(token),
        expiresAt
      }
    })

    return {
      bindUrl: `https://t.me/${config.botUsername}?start=${bindTokenPrefix}${token}`,
      expiresAt: expiresAt.toISOString()
    }
  })

  fastify.delete('/binding', {
    onRequest: [fastify.authenticate]
  }, async (request: FastifyRequest) => {
    await telegramBindingModel.deleteMany({
      where: { userId: request.user.id }
    })

    return { message: 'Telegram binding removed' }
  })

  fastify.post<{ Body: TelegramWebhookUpdate }>('/webhook', async (
    request: FastifyRequest<{ Body: TelegramWebhookUpdate }>,
    reply: FastifyReply
  ) => {
    const config = await getTelegramBotConfig()
    if (!config.configured || !config.botToken) {
      return { ok: true }
    }

    if (config.webhookSecret) {
      const headerValue = request.headers['x-telegram-bot-api-secret-token']
      const secretFromHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue
      if (!secretFromHeader || !secureEquals(secretFromHeader, config.webhookSecret)) {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
    }

    const message = request.body?.message
    const chatId = message?.chat?.id
    const chatType = message?.chat?.type
    const from = message?.from
    const text = message?.text?.trim()
    const bindTokenMatch = text?.match(/^\/start\s+bind_([A-Za-z0-9_-]{20,128})$/)

    if (!chatId || !from || !text) {
      return { ok: true }
    }

    const joinTarget = getGroupJoinTarget(text)
    if (joinTarget) {
      await handleGroupJoinRequest(config, chatId, from, chatType, joinTarget)
      return { ok: true }
    }

    if (!bindTokenMatch) {
      const commandHandled = await handleInteractiveCommand(config, chatId, chatType, from, text)
      if (!commandHandled) {
        await notifyTelegram(
          config.botToken,
          chatId,
          '可用指令：\n绑定账号：请先登录网站，在个人设置里生成 Telegram 绑定链接。\n' +
          '/instances：查看我的实例\n/start 实例名：开机\n/stop 实例名：关机\n' +
          '/traffic 实例名：查本月流量\n/balance：查余额\n' +
          '申请普通群：绑定后私聊发送 /join。\n申请高级群：绑定后私聊发送 /join_vip。'
        )
      }
      return { ok: true }
    }

    const tokenHash = hashToken(bindTokenMatch[1])
    const now = new Date()
    const bindToken = await telegramBindTokenModel.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now }
      }
    })

    if (!bindToken) {
      await notifyTelegram(config.botToken, chatId, '绑定链接无效或已过期，请回到网站重新生成绑定链接。')
      return { ok: true }
    }

    const telegramUserId = String(from.id)
    const existingBinding = await telegramBindingModel.findUnique({
      where: { telegramUserId }
    })
    if (existingBinding && existingBinding.userId !== bindToken.userId) {
      await notifyTelegram(config.botToken, chatId, '这个 Telegram 账号已经绑定到另一个网站账号。')
      return { ok: true }
    }

    await telegramBindingModel.upsert({
      where: { userId: bindToken.userId },
      update: {
        telegramUserId,
        telegramUsername: from.username || null,
        firstName: from.first_name || null,
        lastName: from.last_name || null,
        boundAt: now
      },
      create: {
        userId: bindToken.userId,
        telegramUserId,
        telegramUsername: from.username || null,
        firstName: from.first_name || null,
        lastName: from.last_name || null,
        boundAt: now
      }
    })

    await telegramBindTokenModel.update({
      where: { id: bindToken.id },
      data: { usedAt: now }
    })

    await notifyTelegram(
      config.botToken,
      chatId,
      '绑定成功。你现在可以关闭 Telegram，回到网站个人设置查看状态。'
    )

    return { ok: true }
  })
}
