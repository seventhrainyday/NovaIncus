import { useConfigStore } from '@/stores/config'

export function useBrand() {
  const configStore = useConfigStore()

  return {
    get brandName() {
      return configStore.brandName?.trim() || 'NovaIncus'
    },
    get brandSubtitle() {
      return configStore.brandSubtitle?.trim() || '基于 Incus 的云容器与 VPS 管理平台'
    },
    get brandLogoUrl() {
      return configStore.brandLogoUrl?.trim() || '/novaincus_logo.webp'
    }
  }
}
