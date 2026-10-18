-- NovaIncus Phase 4: 按量计费引擎
-- 新增 HourlyBillingPolicy（套餐方案级按量单价策略）与 HourlyUsageRecord（实例级每小时账单）

-- CreateEnum
CREATE TYPE "HourlyBillingStatus" AS ENUM ('paid', 'arrears');

-- CreateTable: hourly_billing_policies
CREATE TABLE "hourly_billing_policies" (
    "id" SERIAL NOT NULL,
    "package_plan_id" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "cpu_price_per_hour" DECIMAL(10, 4) NOT NULL DEFAULT 0,
    "memory_price_per_gb_hour" DECIMAL(10, 4) NOT NULL DEFAULT 0,
    "disk_price_per_gb_hour" DECIMAL(10, 4) NOT NULL DEFAULT 0,
    "stopped_disk_rate" DECIMAL(5, 4) NOT NULL DEFAULT 0.1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hourly_billing_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable: hourly_usage_records
CREATE TABLE "hourly_usage_records" (
    "id" SERIAL NOT NULL,
    "instance_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "cpu" INTEGER NOT NULL,
    "memory" INTEGER NOT NULL,
    "disk" INTEGER NOT NULL,
    "amount" DECIMAL(10, 2) NOT NULL,
    "status" "HourlyBillingStatus" NOT NULL DEFAULT 'paid',
    "balance_log_id" INTEGER,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hourly_usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hourly_billing_policies_package_plan_id_key" ON "hourly_billing_policies"("package_plan_id");
CREATE INDEX "hourly_usage_records_instance_id_period_start_idx" ON "hourly_usage_records"("instance_id", "period_start" DESC);
CREATE INDEX "hourly_usage_records_user_id_created_at_idx" ON "hourly_usage_records"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "hourly_billing_policies" ADD CONSTRAINT "hourly_billing_policies_package_plan_id_fkey" FOREIGN KEY ("package_plan_id") REFERENCES "package_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hourly_usage_records" ADD CONSTRAINT "hourly_usage_records_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 系统配置：按量计费连续欠费封停阈值（小时）
INSERT INTO "system_configs" ("key", "value", "type", "label", "description", "created_at", "updated_at")
VALUES
  ('hourly_billing_arrears_suspend_hours', '24', 'number', '按量欠费封停阈值', '实例按量计费连续欠费超过该小时数后自动封停', NOW(), NOW())
ON CONFLICT ("key") DO NOTHING;
