/**
 * 按量计费 Worker（NovaIncus Phase 4）
 *
 * 每小时整点运行一次：对启用按量计费的实例按当前配置
 * （CPU/内存/磁盘）× 方案单价 × 1 小时扣费；已关机实例仅收存储费。
 * 余额不足时记欠费账单并通知用户；连续欠费超过阈值（默认 24 小时）
 * 则自动封停实例。
 */

import { schedule } from 'node-cron'
import pLimit from 'p-limit'
import { prisma } from '../db/prisma.js'
import * as db from '../db/index.js'
import { roundMoney } from '../lib/balance-transfer.js'
import { sendNotification } from '../lib/notifier.js'
import { getIncusClient } from '../lib/incus/index.js'

const TAG = '[HourlyBilling]'

// 每小时整点
const CRON_EXPRESSION = '0 * * * *'
// 单实例计费并发数
const BILLING_CONCURRENCY = 5
// 计费周期：1 小时
const BILLING_PERIOD_MS = 60 * 60 * 1000

let cronTask: ReturnType<typeof schedule> | null = null

interface BillableInstance {
  id: number
  name: string
  userId: number
  hostId: number
  incusId: string
  status: string
  cpu: number
  memory: number
  disk: number
  policy: {
    cpuPricePerHour: number
    memoryPricePerGbHour: number
    diskPricePerGbHour: number
    stoppedDiskRate: number
  }
}

/**
 * 计算单周期费用（元）
 * - 运行中：CPU(核) × 单价 + 内存(GB) × 单价 + 磁盘(GB) × 单价
 * - 已关机：仅收磁盘费 × 关机费率
 */
function calculatePeriodAmount(instance: BillableInstance): number {
  const { cpuPricePerHour, memoryPricePerGbHour, diskPricePerGbHour, stoppedDiskRate } = instance.policy
  const diskGb = instance.disk / 1024
  if (instance.status === 'stopped') {
    return roundMoney(diskGb * Number(diskPricePerGbHour) * Number(stoppedDiskRate))
  }
  const cpuCores = instance.cpu / 100
  const memoryGb = instance.memory / 1024
  const amount =
    cpuCores * Number(cpuPricePerHour) +
    memoryGb * Number(memoryPricePerGbHour) +
    diskGb * Number(diskPricePerGbHour)
  return roundMoney(amount)
}

/**
 * 欠费封停：复用封停语义（suspendReason=hourly_arrears），并尝试停止 Incus 容器
 */
async function suspendForArrears(instance: BillableInstance, arrearsHours: number): Promise<void> {
  await prisma.instance.update({
    where: { id: instance.id },
    data: {
      status: 'suspended',
      suspendedAt: new Date(),
      suspendedBy: null, // 系统自动
      suspendReason: 'hourly_arrears'
    }
  })

  // 尝试停止 Incus 侧容器（失败不影响封停）
  try {
    const host = await db.getHostById(instance.hostId)
    if (host) {
      const client = await getIncusClient(host)
      const { stopInstance } = await import('../lib/incus/index.js')
      await stopInstance(client, instance.incusId, true)
    }
  } catch (stopError) {
    console.log(`${TAG} 停止 Incus 实例 ${instance.incusId} 失败:`, stopError)
  }

  await sendNotification(instance.userId, 'hourly_billing_suspended', {
    instanceName: instance.name,
    arrearsHours
  })
  console.log(`${TAG} 实例 ${instance.name} 连续欠费 ${arrearsHours} 小时，已封停`)
}

/**
 * 对单个实例执行一小时计费
 */
async function billInstance(instance: BillableInstance, suspendAfterHours: number): Promise<void> {
  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - BILLING_PERIOD_MS)

  // 幂等：本周期已记账则跳过（Worker 重启/重跑不重复扣费）
  const existing = await prisma.hourlyUsageRecord.findFirst({
    where: {
      instanceId: instance.id,
      periodStart: { gte: periodStart }
    },
    select: { id: true }
  })
  if (existing) {
    return
  }

  const amount = calculatePeriodAmount(instance)
  const remark = `按量计费 ${periodStart.toISOString()} ~ ${periodEnd.toISOString()}（${instance.status === 'stopped' ? '关机仅收存储费' : '运行中'}）`

  const deductResult = await db.consumeBalance(instance.userId, amount, instance.id, remark)

  if (deductResult.success) {
    await prisma.hourlyUsageRecord.create({
      data: {
        instanceId: instance.id,
        userId: instance.userId,
        periodStart,
        periodEnd,
        cpu: instance.cpu,
        memory: instance.memory,
        disk: instance.disk,
        amount,
        status: 'paid',
        balanceLogId: deductResult.balanceLog?.id ?? null,
        remark
      }
    })
    return
  }

  // 余额不足：记欠费账单
  const record = await prisma.hourlyUsageRecord.create({
    data: {
      instanceId: instance.id,
      userId: instance.userId,
      periodStart,
      periodEnd,
      cpu: instance.cpu,
      memory: instance.memory,
      disk: instance.disk,
      amount,
      status: 'arrears',
      remark: `${remark}；扣款失败（${deductResult.error || '余额不足'}），已记欠费`
    }
  })

  // 连续欠费小时数 = 最近连续 arrears 记录条数（每小时一条）
  const recent = await prisma.hourlyUsageRecord.findMany({
    where: { instanceId: instance.id },
    orderBy: { periodStart: 'desc' },
    take: suspendAfterHours + 2,
    select: { status: true }
  })
  let consecutiveArrears = 0
  for (const r of recent) {
    if (r.status === 'arrears') consecutiveArrears++
    else break
  }

  // 首次进入欠费时通知用户（避免每小时 spam）
  const wasArrears = recent.length > 1 && recent[1].status === 'arrears'
  if (!wasArrears) {
    await sendNotification(instance.userId, 'hourly_billing_arrears', {
      instanceName: instance.name,
      amount,
      arrearsHours: consecutiveArrears
    }).catch(err => console.warn(`${TAG} 发送欠费通知失败:`, err))
  }

  console.log(`${TAG} 实例 ${instance.name} 欠费 ¥${amount}（连续 ${consecutiveArrears} 小时），记录 #${record.id}`)

  if (consecutiveArrears >= suspendAfterHours) {
    await suspendForArrears(instance, consecutiveArrears)
  }
}

/**
 * 执行一轮按量计费
 */
export async function runHourlyBilling(): Promise<void> {
  const startTime = Date.now()
  try {
    const suspendAfterHours = await db.getSystemConfigFloat('hourly_billing_arrears_suspend_hours', 24)

    // 启用按量计费且处于 running/stopped 的实例
    const instances = await prisma.instance.findMany({
      where: {
        status: { in: ['running', 'stopped'] },
        packagePlan: {
          hourlyBillingPolicy: { enabled: true }
        }
      },
      select: {
        id: true,
        name: true,
        userId: true,
        hostId: true,
        incusId: true,
        status: true,
        cpu: true,
        memory: true,
        disk: true,
        packagePlan: {
          select: {
            hourlyBillingPolicy: {
              select: {
                cpuPricePerHour: true,
                memoryPricePerGbHour: true,
                diskPricePerGbHour: true,
                stoppedDiskRate: true
              }
            }
          }
        }
      }
    })

    console.log(`${TAG} 本轮待计费实例 ${instances.length} 个`)

    const limit = pLimit(BILLING_CONCURRENCY)
    const billable: BillableInstance[] = instances
      .filter(i => i.packagePlan?.hourlyBillingPolicy)
      .map(i => ({
        id: i.id,
        name: i.name,
        userId: i.userId,
        hostId: i.hostId,
        incusId: i.incusId,
        status: i.status,
        cpu: i.cpu,
        memory: i.memory,
        disk: i.disk,
        policy: {
          cpuPricePerHour: Number(i.packagePlan!.hourlyBillingPolicy!.cpuPricePerHour),
          memoryPricePerGbHour: Number(i.packagePlan!.hourlyBillingPolicy!.memoryPricePerGbHour),
          diskPricePerGbHour: Number(i.packagePlan!.hourlyBillingPolicy!.diskPricePerGbHour),
          stoppedDiskRate: Number(i.packagePlan!.hourlyBillingPolicy!.stoppedDiskRate)
        }
      }))

    await Promise.all(
      billable.map(instance =>
        limit(() =>
          billInstance(instance, suspendAfterHours).catch(err =>
            console.error(`${TAG} 实例 ${instance.name} 计费失败:`, err)
          )
        )
      )
    )

    console.log(`${TAG} 本轮完成，耗时 ${Date.now() - startTime}ms`)
  } catch (error) {
    console.error(`${TAG} 计费轮次失败:`, error)
  }
}

/**
 * 启动按量计费 Worker（每小时整点）
 */
export function startHourlyBillingWorker(): void {
  if (cronTask) {
    console.warn(`${TAG} Worker 已在运行`)
    return
  }
  console.log(`${TAG} 启动 Worker（${CRON_EXPRESSION}）...`)
  cronTask = schedule(CRON_EXPRESSION, () => {
    runHourlyBilling().catch(err => console.error(`${TAG} 定时任务错误:`, err))
  })
  console.log(`${TAG} Worker 已启动`)
}

/**
 * 停止按量计费 Worker
 */
export function stopHourlyBillingWorker(): void {
  if (cronTask) {
    cronTask.stop()
    cronTask = null
  }
  console.log(`${TAG} Worker 已停止`)
}
